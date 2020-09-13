export const HEADER_LENGTH = 16
export const MAGIC_STRING = 'Yaz0'
export const GROUP_HEADER_LENGTH = 1
export const MIN_CHUNK_INPUT_LENGTH = 1
export const MIN_BACKREF_CHUNK_INPUT_LENGTH = 2
export const MAX_CHUNK_INPUT_LENGTH = 3
export const CHUNK_DISTANCE_OFFSET = 1
export const SHORT_CHUNK_LENGTH_OFFSET = 2
export const LONG_CHUNK_LENGTH_OFFSET = 18
export const CHUNKS_PER_GROUP = 8
export const MAX_CHUNK_DISTANCE = 0x1000
export const MAX_CHUNK_OUTPUT_LENGTH = 0x111
export const MIN_GROUP_INPUT_LENGTH =
  GROUP_HEADER_LENGTH + MIN_CHUNK_INPUT_LENGTH * CHUNKS_PER_GROUP
export const MAX_GROUP_OUTPUT_LENGTH =
  MAX_CHUNK_OUTPUT_LENGTH * CHUNKS_PER_GROUP
export const DEFAULT_DECOMPRESSED_BUFFER_LIMIT = 100 * 1024 * 1024
