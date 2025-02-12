import { promises as fs, existsSync } from 'fs';
import path from 'path';

import { LoadedTranslation, UserConfig } from '@vocab/types';
import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  MessageFormatElement,
  parse,
} from '@formatjs/icu-messageformat-parser';
import prettier from 'prettier';
import chokidar from 'chokidar';

import {
  getTranslationMessages,
  getDevTranslationFileGlob,
  getTSFileFromDevLanguageFile,
  getDevLanguageFileFromAltLanguageFile,
  getAltTranslationFileGlob,
  isDevLanguageFile,
  isAltLanguageFile,
  getTranslationFolderGlob,
  devTranslationFileName,
  isTranslationDirectory,
} from './utils';
import { trace } from './logger';
import { loadAllTranslations, loadTranslation } from './load-translations';

type ICUParams = { [key: string]: string };

interface TranslationTypeInfo {
  params: ICUParams;
  message: string;
  returnType: string;
  hasTags: boolean;
}

const encodeWithinSingleQuotes = (v: string) => v.replace(/'/g, "\\'");

const encodeBackslash = (v: string) => v.replace(/\\/g, '\\\\');

function extractHasTags(ast: MessageFormatElement[]): boolean {
  return ast.some((element) => {
    if (isSelectElement(element)) {
      const children = Object.values(element.options).map((o) => o.value);
      return children.some((child) => extractHasTags(child));
    }
    return isTagElement(element);
  });
}

function extractParamTypes(
  ast: MessageFormatElement[],
): [params: ICUParams, imports: Set<string>] {
  let params: ICUParams = {};
  let imports = new Set<string>();

  for (const element of ast) {
    if (isArgumentElement(element)) {
      params[element.value] = 'string';
    } else if (isNumberElement(element)) {
      params[element.value] = 'number';
    } else if (isPluralElement(element)) {
      params[element.value] = 'number';
    } else if (isDateElement(element) || isTimeElement(element)) {
      params[element.value] = 'Date | number';
    } else if (isTagElement(element)) {
      params[element.value] = 'FormatXMLElementFn<T>';
      imports.add(`import { FormatXMLElementFn } from '@vocab/types';`);

      const [subParams, subImports] = extractParamTypes(element.children);

      imports = new Set([...imports, ...subImports]);
      params = { ...params, ...subParams };
    } else if (isSelectElement(element)) {
      params[element.value] = Object.keys(element.options)
        .map((o) => `'${o}'`)
        .join(' | ');

      const children = Object.values(element.options).map((o) => o.value);

      for (const child of children) {
        const [subParams, subImports] = extractParamTypes(child);

        imports = new Set([...imports, ...subImports]);
        params = { ...params, ...subParams };
      }
    }
  }

  return [params, imports];
}

function serialiseObjectToType(v: any) {
  let result = '';

  for (const [key, value] of Object.entries(v)) {
    if (value && typeof value === 'object') {
      result += `'${encodeWithinSingleQuotes(key)}': ${serialiseObjectToType(
        value,
      )},`;
    } else {
      result += `'${encodeWithinSingleQuotes(key)}': ${value},`;
    }
  }

  return `{ ${result} }`;
}

const banner = `// This file is automatically generated by Vocab.\n// To make changes update translation.json files directly.`;

function serialiseTranslationRuntime(
  value: Map<string, TranslationTypeInfo>,
  imports: Set<string>,
  loadedTranslation: LoadedTranslation,
) {
  trace('Serialising translations:', loadedTranslation);
  const translationsType: any = {};

  for (const [key, { params, message, hasTags }] of value.entries()) {
    let translationFunctionString = `() => ${message}`;

    if (Object.keys(params).length > 0) {
      const formatGeneric = hasTags ? '<T = string>' : '';
      const formatReturn = hasTags
        ? 'string | T | Array<string | T>'
        : 'string';
      translationFunctionString = `${formatGeneric}(values: ${serialiseObjectToType(
        params,
      )}) => ${formatReturn}`;
    }

    translationsType[encodeBackslash(key)] = translationFunctionString;
  }

  const content = Object.entries(loadedTranslation.languages)
    .map(
      ([languageName, translations]) =>
        `'${encodeWithinSingleQuotes(
          languageName,
        )}': createLanguage(${JSON.stringify(
          getTranslationMessages(translations),
        )})`,
    )
    .join(',');

  const languagesUnionAsString = Object.keys(loadedTranslation.languages)
    .map((l) => `'${l}'`)
    .join(' | ');

  return `${banner}

  ${Array.from(imports).join('\n')}
  import { createLanguage, createTranslationFile } from '@vocab/core/runtime';

  const translations = createTranslationFile<${languagesUnionAsString}, ${serialiseObjectToType(
    translationsType,
  )}>({${content}});

  export default translations;`;
}

export async function generateRuntime(loadedTranslation: LoadedTranslation) {
  const { languages: loadedLanguages, filePath } = loadedTranslation;

  trace('Generating types for', loadedTranslation.filePath);
  const translationTypes = new Map<string, TranslationTypeInfo>();

  let imports = new Set<string>();

  for (const key of loadedTranslation.keys) {
    let params: ICUParams = {};
    const messages = new Set();
    let hasTags = false;

    for (const translatedLanguage of Object.values(loadedLanguages)) {
      if (translatedLanguage[key]) {
        const ast = parse(translatedLanguage[key].message);

        hasTags = hasTags || extractHasTags(ast);

        const [parsedParams, parsedImports] = extractParamTypes(ast);
        imports = new Set([...imports, ...parsedImports]);

        params = {
          ...params,
          ...parsedParams,
        };
        messages.add(
          `'${encodeWithinSingleQuotes(translatedLanguage[key].message)}'`,
        );
      }
    }

    const returnType = hasTags ? 'NonNullable<ReactNode>' : 'string';

    translationTypes.set(key, {
      params,
      hasTags,
      message: Array.from(messages).join(' | '),
      returnType,
    });
  }

  const prettierConfig = await prettier.resolveConfig(filePath);
  const serializedTranslationType = serialiseTranslationRuntime(
    translationTypes,
    imports,
    loadedTranslation,
  );
  const declaration = prettier.format(serializedTranslationType, {
    ...prettierConfig,
    parser: 'typescript',
  });
  const outputFilePath = getTSFileFromDevLanguageFile(filePath);
  trace(`Writing translation types to ${outputFilePath}`);
  await writeIfChanged(outputFilePath, declaration);
}

export function watch(config: UserConfig) {
  const cwd = config.projectRoot || process.cwd();

  const watcher = chokidar.watch(
    [
      getDevTranslationFileGlob(config),
      getAltTranslationFileGlob(config),
      getTranslationFolderGlob(config),
    ],
    {
      cwd,
      ignored: config.ignore
        ? [...config.ignore, '**/node_modules/**']
        : ['**/node_modules/**'],
      ignoreInitial: true,
    },
  );

  const onTranslationChange = async (relativePath: string) => {
    trace(`Detected change for file ${relativePath}`);

    let targetFile;

    if (isDevLanguageFile(relativePath)) {
      targetFile = path.resolve(cwd, relativePath);
    } else if (isAltLanguageFile(relativePath)) {
      targetFile = getDevLanguageFileFromAltLanguageFile(
        path.resolve(cwd, relativePath),
      );
    }

    if (targetFile) {
      try {
        const loadedTranslation = await loadTranslation(
          { filePath: targetFile, fallbacks: 'all' },
          config,
        );

        await generateRuntime(loadedTranslation);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('Failed to generate types for', relativePath);
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }
  };

  const onNewDirectory = async (relativePath: string) => {
    trace('Detected new directory', relativePath);
    if (!isTranslationDirectory(relativePath, config)) {
      trace('Ignoring non-translation directory:', relativePath);
      return;
    }
    const newFilePath = path.join(relativePath, devTranslationFileName);
    if (!existsSync(newFilePath)) {
      await fs.writeFile(newFilePath, JSON.stringify({}, null, 2));
      trace('Created new empty translation file:', newFilePath);
    } else {
      trace(
        `New directory already contains translation file. Skipping creation. Existing file ${newFilePath}`,
      );
    }
  };

  watcher.on('addDir', onNewDirectory);
  watcher.on('add', onTranslationChange).on('change', onTranslationChange);

  return () => watcher.close();
}

export async function compile(
  { watch: shouldWatch = false } = {},
  config: UserConfig,
) {
  const translations = await loadAllTranslations(
    { fallbacks: 'all', includeNodeModules: false },
    config,
  );

  for (const loadedTranslation of translations) {
    await generateRuntime(loadedTranslation);
  }

  if (shouldWatch) {
    trace('Listening for changes to files...');
    return watch(config);
  }
}

async function writeIfChanged(filepath: string, contents: string) {
  let hasChanged = true;

  try {
    const existingContents = await fs.readFile(filepath, { encoding: 'utf-8' });

    hasChanged = existingContents !== contents;
  } catch (e) {
    // ignore error, likely a file doesn't exist error so we want to write anyway
  }

  if (hasChanged) {
    await fs.writeFile(filepath, contents, { encoding: 'utf-8' });
  }
}
