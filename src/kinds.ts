// The Link file kind of a file name, from its extension: Link's `file_kind_for_extension` (crates/arcade-link/
// src/content.rs). test/fixtures/content-vectors.json is Link's spec/vectors/content.json, checked against this.

const KINDS: Record<string, string> = {
  svg: 'svg svgz',
  csv: 'csv tsv',
  json: 'json jsonl ndjson geojson',
  html: 'html htm xhtml',
  markdown: 'md markdown mdown mkd',
  ebook: 'epub mobi azw3 fb2 djvu',
  subtitle: 'srt vtt ass ssa sub sbv lrc',
  image: 'png jpg jpeg jpe jfif gif webp bmp tif tiff heic heif avif ico jxl tga qoi psd raw cr2 nef dng arw exr hdr',
  video: 'mp4 mkv mov webm avi m4v wmv flv mpg mpeg 3gp ogv',
  audio: 'mp3 wav flac ogg oga opus m4a aac wma aiff aif alac mid midi',
  pdf: 'pdf',
  document: 'doc docx odt rtf pages',
  spreadsheet: 'xls xlsx ods numbers',
  presentation: 'ppt pptx odp key',
  archive: 'zip tar gz tgz bz2 xz 7z rar zst lz lzma cab iso',
  text: 'txt log ini cfg conf nfo',
  code: 'rs c h cpp hpp cc py js mjs ts tsx jsx java kt go rb php swift cs sh bash zsh fish ps1 yaml yml toml xml css scss sql lua dart qml vue svelte',
  font: 'ttf otf woff woff2 ttc',
  model: 'obj stl gltf glb fbx 3mf dae ply',
};

const BY_EXTENSION = new Map<string, string>();
for (const [kind, exts] of Object.entries(KINDS)) for (const ext of exts.split(' ')) BY_EXTENSION.set(ext, kind);

/** `file/<kind>` for a file name or path; unknown extensions are `file/any`. */
export function fileTypeForName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return `file/${BY_EXTENSION.get(ext) ?? 'any'}`;
}
