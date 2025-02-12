import path from 'path';
import { push } from './push-translations';
import { pushTranslationsByLocale } from './phrase-api';
import { writeFile } from './file';

jest.mock('./file', () => ({
  writeFile: jest.fn(() => Promise.resolve),
  mkdir: jest.fn(() => Promise.resolve),
}));

jest.mock('./phrase-api', () => ({
  ensureBranch: jest.fn(() => Promise.resolve()),
  pushTranslationsByLocale: jest.fn(() => Promise.resolve({ en: {}, fr: {} })),
}));

function runPhrase() {
  return push(
    { branch: 'tester' },
    {
      devLanguage: 'en',
      languages: [{ name: 'en' }, { name: 'fr' }],
      generatedLanguages: [
        {
          name: 'generatedLanguage',
          extends: 'en',
          generator: {
            transformMessage: (message: string) => `[${message}]`,
          },
        },
      ],
      projectRoot: path.resolve(__dirname, '..', '..', '..', 'fixtures/phrase'),
    },
  );
}

describe('push', () => {
  beforeEach(() => {
    (pushTranslationsByLocale as jest.Mock).mockClear();
    (writeFile as jest.Mock).mockClear();
  });

  it('should resolve', async () => {
    await expect(runPhrase()).resolves.toBeUndefined();

    expect(pushTranslationsByLocale as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('should update keys', async () => {
    await expect(runPhrase()).resolves.toBeUndefined();

    expect(pushTranslationsByLocale as jest.Mock).toHaveBeenCalledWith(
      {
        'hello.mytranslations': {
          message: 'Hello',
        },
        'world.mytranslations': {
          message: 'world',
        },
      },
      'en',
      'tester',
    );

    expect(pushTranslationsByLocale as jest.Mock).toHaveBeenCalledWith(
      {
        'hello.mytranslations': {
          message: 'Bonjour',
        },
        'world.mytranslations': {
          message: 'monde',
        },
      },
      'fr',
      'tester',
    );
  });
});
