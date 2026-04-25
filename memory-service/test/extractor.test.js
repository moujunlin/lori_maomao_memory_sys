import test from 'node:test';

// TDD skeleton for extractor v1.
// Intentionally kept out of all.test.js until extractor.js lands.
//
// Suggested imports once implementation starts:
// import assert from 'node:assert/strict';
// import fs from 'node:fs/promises';
// import os from 'node:os';
// import path from 'node:path';
// import { loadConfig, resetConfig } from '../config.js';
// import * as extractor from '../src/extractor.js';
// import * as indexer from '../src/indexer.js';
// import * as bucketManager from '../src/bucket_manager.js';
// import { readBucketFile } from '../src/storage.js';

test.todo('extractor.hold creates one bucket for one valid item');
test.todo('extractor.hold does not merge a newly created bucket with itself');
test.todo('extractor.hold can merge a later item into an earlier similar bucket in the same batch');
test.todo('extractor.hold records a failed item and continues processing the rest of the batch');
test.todo('extractor.grow wraps raw text into a single user turn before calling dehydrator.dehydrate');
test.todo('extractor.grow writes a pending file when dehydrator.dehydrate fails');
test.todo('extractor.growStructured skips invalid items and continues processing valid ones');
test.todo('extractor.sweepPending increments attempts and preserves the file when retry fails');
test.todo('indexer.findSimilar returns an empty array when no similar bucket is found');
