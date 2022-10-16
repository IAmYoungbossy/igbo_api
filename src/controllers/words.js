import { map } from 'lodash';
import mongoose from 'mongoose';
import removePrefix from '../shared/utils/removePrefix';
import Word from '../models/Word';
import { findSearchWord } from '../services/words';
import { NO_PROVIDED_TERM } from '../shared/constants/errorMessages';
import { getDocumentsIds } from '../shared/utils/documentUtils';
import createRegExp from '../shared/utils/createRegExp';
import { REDIS_CACHE_EXPIRATION } from '../config';
import { sortDocsBy, packageResponse, handleQueries } from './utils';
import { searchIgboTextSearch, strictSearchIgboQuery, searchEnglishRegexQuery } from './utils/queries';
import { findWordsWithMatch } from './utils/buildDocs';
import { createExample } from './examples';

/* Gets words from JSON dictionary */
export const getWordData = (req, res, next) => {
  try {
    const { keyword } = req.query;
    const searchWord = removePrefix(keyword);
    if (!searchWord) {
      throw new Error(NO_PROVIDED_TERM);
    }
    const regexWord = createRegExp(searchWord);
    return res.send(findSearchWord(regexWord, searchWord));
  } catch (err) {
    return next(err);
  }
};

/* Searches for a word with Igbo stored in MongoDB */
export const searchWordUsingIgbo = async ({ query, searchWord, ...rest }) => {
  const words = await findWordsWithMatch({ match: query, ...rest });
  return sortDocsBy(searchWord, words, 'word');
};

/* Searches for word with English stored in MongoDB */
export const searchWordUsingEnglish = async ({ query, searchWord, ...rest }) => {
  const words = await findWordsWithMatch({ match: query, ...rest });
  return sortDocsBy(searchWord, words, 'definitions[0]');
};

/* Creates an object containing truthy key/value pairs for looking up words */
const generateFilteringParams = (filteringParams) => (
  Object.entries(filteringParams).reduce((finalRequiredAttributes, [key, value]) => {
    if (key === 'isStandardIgbo' && value) {
      return {
        ...finalRequiredAttributes,
        [`attributes.${key}`]: { $eq: true },
      };
    }
    if (key === 'nsibidi' && value) {
      return {
        ...finalRequiredAttributes,
        [key]: { $ne: '' },
      };
    }
    if (key === 'pronunciation' && value) {
      return {
        ...finalRequiredAttributes,
        pronunciation: { $exists: true },
        $expr: { $gt: [{ $strLenCP: '$pronunciation' }, 10] },
      };
    }
    return finalRequiredAttributes;
  }, {})
);

/* Reuseable base controller function for getting words */
const getWordsFromDatabase = async (req, res, next, redisClient) => {
  try {
    const hasQuotes = req.query.keyword && (req.query.keyword.match(/["'].*["']/) !== null);
    if (hasQuotes) {
      req.query.keyword = req.query.keyword.replace(/["']/g, '');
    }
    const {
      searchWord,
      regexKeyword,
      skip,
      limit,
      strict,
      dialects,
      examples,
      wordFields,
      isUsingMainKey,
      ...rest
    } = handleQueries(req);
    const searchQueries = {
      searchWord,
      skip,
      limit,
      dialects,
      examples,
    };
    let words;
    let query;
    const filteringParams = generateFilteringParams(wordFields);
    if (hasQuotes) {
      const redisCacheKey = `"${searchWord}"-${skip}-${limit}-${dialects}-${examples}`;
      const cachedWords = await redisClient.get(redisCacheKey);
      if (cachedWords) {
        words = cachedWords;
      } else {
        query = searchEnglishRegexQuery({ regex: regexKeyword, filteringParams });
        words = await searchWordUsingEnglish({ query, ...searchQueries });
        redisClient.set(redisCacheKey, JSON.stringify(words), 'EX', REDIS_CACHE_EXPIRATION);
      }
    } else {
      const regularSearchIgboQuery = searchIgboTextSearch({
        keyword: searchWord,
        regex: regexKeyword,
        isUsingMainKey,
        filteringParams,
      });
      query = !strict
        ? regularSearchIgboQuery
        : strictSearchIgboQuery(
          searchWord,
        );
      const redisCacheKey = `${searchWord}-${skip}-${limit}-${dialects}-${examples}`;
      const cachedWords = await redisClient.get(redisCacheKey);
      if (cachedWords) {
        words = cachedWords;
      } else {
        words = await searchWordUsingIgbo({ query, ...searchQueries });
        redisClient.set(redisCacheKey, JSON.stringify(words), 'EX', REDIS_CACHE_EXPIRATION);
        if (!words.length) {
          query = searchEnglishRegexQuery({ regex: regexKeyword, filteringParams });
          words = await searchWordUsingEnglish({ query, ...searchQueries });
          redisClient.set(redisCacheKey, JSON.stringify(words), 'EX', REDIS_CACHE_EXPIRATION);
        }
      }
    }
    return packageResponse({
      res,
      docs: words,
      model: Word,
      query,
      ...rest,
    });
  } catch (err) {
    return next(err);
  }
};
/* Gets words from MongoDB */
export const getWords = (redisClient) => async (req, res, next) => {
  try {
    return getWordsFromDatabase(req, res, next, redisClient);
  } catch (err) {
    return next(err);
  }
};

/* Returns a word from MongoDB using an id */
export const getWord = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { dialects, examples } = handleQueries(req);

    const updatedWord = await findWordsWithMatch({
      match: { _id: mongoose.Types.ObjectId(id) },
      limit: 1,
      dialects,
      examples,
    })
      .then(async ([word]) => {
        if (!word) {
          throw new Error('No word exists with the provided id.');
        }
        return word;
      });
    return res.send(updatedWord);
  } catch (err) {
    return next(err);
  }
};

/* Creates Word documents in MongoDB database */
export const createWord = async (data) => {
  const {
    examples,
    word,
    wordClass,
    definitions,
    variations,
    stems,
    dialects,
    ...rest
  } = data;

  const wordData = {
    word,
    wordClass,
    definitions,
    variations,
    stems,
    dialects,
    ...rest,
  };

  const newWord = new Word(wordData);
  await newWord.save();

  /* Go through each word's example and create an Example document */
  const savedExamples = map(examples, async (example) => {
    const exampleData = {
      ...example,
      associatedWords: [newWord.id],
    };
    return createExample(exampleData);
  });

  /* Wait for all the Examples to be created and then add them to the Word document */
  const resolvedExamples = await Promise.all(savedExamples);
  const exampleIds = getDocumentsIds(resolvedExamples);
  newWord.examples = exampleIds;
  return newWord.save();
};
