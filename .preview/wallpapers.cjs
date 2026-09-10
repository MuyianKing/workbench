var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/wallpapers.ts
var wallpapers_exports = {};
__export(wallpapers_exports, {
  listWallpapers: () => listWallpapers,
  resolveBackgroundTarget: () => resolveBackgroundTarget
});
module.exports = __toCommonJS(wallpapers_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_electron = require("electron");

// src/shared/wallpaper.ts
var BUILTIN_WALLPAPER_PREFIX = "builtin:";
var WALLPAPER_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
function wallpaperIdOf(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}
function builtinReference(id) {
  return `${BUILTIN_WALLPAPER_PREFIX}${id}`;
}
function isSafeWallpaperId(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (value.includes("..")) return false;
  return !/[/\\:*?"<>|\u0000-\u001f]/.test(value);
}
function builtinIdOf(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith(BUILTIN_WALLPAPER_PREFIX)) return null;
  const id = text.slice(BUILTIN_WALLPAPER_PREFIX.length);
  return isSafeWallpaperId(id) ? id : null;
}
function isWallpaperFile(fileName) {
  if (typeof fileName !== "string") return false;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return WALLPAPER_EXTENSIONS.includes(ext);
}

// src/main/wallpapers.ts
function builtinDir() {
  return import_electron.app.isPackaged ? (0, import_node_path.join)(process.resourcesPath, "backgrounds") : (0, import_node_path.join)(import_electron.app.getAppPath(), "resources", "backgrounds");
}
async function scanWallpaperFiles() {
  const dir = builtinDir();
  let entries;
  try {
    entries = await import_node_fs.promises.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => isWallpaperFile(name)).sort((a, b) => a.localeCompare(b)).map((name) => ({ id: wallpaperIdOf(name), name, file: (0, import_node_path.join)(dir, name) }));
}
var THUMBNAIL_WIDTH = 360;
function thumbnailOf(file) {
  const image = import_electron.nativeImage.createFromPath(file);
  if (image.isEmpty()) return "";
  const { width } = image.getSize();
  const scaled = width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: "good" }) : image;
  return `data:image/jpeg;base64,${scaled.toJPEG(72).toString("base64")}`;
}
async function listWallpapers() {
  const files = await scanWallpaperFiles();
  return files.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reference: builtinReference(entry.id),
    thumbnail: thumbnailOf(entry.file)
  }));
}
async function resolveBackgroundTarget(value) {
  if (!value.startsWith(BUILTIN_WALLPAPER_PREFIX)) return { ok: true, data: value };
  const id = builtinIdOf(value);
  if (id === null) return { ok: false, error: "\u5185\u7F6E\u58C1\u7EB8\u7684\u5F15\u7528\u4E0D\u5408\u6CD5" };
  const matched = (await scanWallpaperFiles()).find((entry) => entry.id === id);
  if (!matched) return { ok: false, error: "\u8FD9\u5F20\u5185\u7F6E\u58C1\u7EB8\u5DF2\u7ECF\u4E0D\u5728\u5B89\u88C5\u76EE\u5F55\u91CC\u4E86" };
  return { ok: true, data: matched.file };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  listWallpapers,
  resolveBackgroundTarget
});
