/** The length of a Yaz0 file header in bytes. */
export const HEADER_LENGTH = 16

/** The ASCII magic string beginning a Yaz0 file. */
export const MAGIC_STRING = 'Yaz0'

/** The length of a Yaz0 group header in bytes. */
export const GROUP_HEADER_LENGTH = 1

/** The minimum length of a compressed or decompressed Yaz0 chunk in bytes. */
export const MIN_CHUNK_LENGTH = 1

/** The minimum length of a compressed Yaz0 chunk in bytes. */
export const MIN_COMPRESSED_CHUNK_LENGTH = 2

/** The maximum length of a compressed Yaz0 chunk in bytes. */
export const MAX_COMPRESSED_CHUNK_LENGTH = 3

/** The value added to the distance of a Yaz0 chunk. */
export const CHUNK_DISTANCE_OFFSET = 1

/** The width of a Yaz0 chunk distance in bits. */
export const CHUNK_DISTANCE_WIDTH = 12

/** The value added to a the length of a short Yaz0 chunk. */
export const SHORT_CHUNK_LENGTH_OFFSET = 2

/** The value added to a the length of a long Yaz0 chunk. */
export const LONG_CHUNK_LENGTH_OFFSET = 18

/** The number of chunks in a Yaz0 group. */
export const CHUNKS_PER_GROUP = 8

/** The maximum distance of a Yaz0 backreference chunk in bytes. */
export const MAX_CHUNK_DISTANCE = 0x1000

/** The maximum length of a decompressed Yaz0 chunk in bytes. */
export const MAX_DECOMPRESSED_CHUNK_LENGTH = 0x111

/** The maximum length of a decompressed short Yaz0 chunk in bytes. */
export const MAX_DECOMPRESSED_SHORT_CHUNK_LENGTH = 0x11

/** The minimum length of a compressed Yaz0 group in bytes. */
export const MIN_COMPRESSED_GROUP_LENGTH =
  GROUP_HEADER_LENGTH + MIN_CHUNK_LENGTH * CHUNKS_PER_GROUP

/** The maximum length of a compressed Yaz0 group in bytes. */
export const MAX_COMPRESSED_GROUP_LENGTH =
  GROUP_HEADER_LENGTH + MAX_COMPRESSED_CHUNK_LENGTH * CHUNKS_PER_GROUP

/** The maximum length of a decompressed Yaz0 group in bytes. */
export const MAX_DECOMPRESSED_GROUP_LENGTH =
  MAX_DECOMPRESSED_CHUNK_LENGTH * CHUNKS_PER_GROUP
