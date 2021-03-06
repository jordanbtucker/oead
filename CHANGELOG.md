# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Added more descriptive text to a couple error messages in `decompress`.
- Fixed an infinite loop bug in `decompress`.

## [0.3.0] - 2020-09-16

### Changed

- Made some performance tweaks to decompression.
- Added an overload to `decompressFile` to write the decompressed data to a
  path. The `encoding` parameter has been removed, so an encoding can only be
  specified in the `options` parameter now.

## [0.2.0] - 2020-09-13

### Added

- A `decompressBuffer` function.

### Changed

- Removed the `options` param from `decompressFile`.

## [0.1.0] - 2020-09-13

### Added

- Yaz0 decompression.

[unreleased]: https://github.com/jordanbtucker/oead/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jordanbtucker/oead/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jordanbtucker/oead/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jordanbtucker/oead/releases/tag/v0.1.0
