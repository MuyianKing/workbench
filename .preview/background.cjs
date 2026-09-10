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

// src/main/background.ts
var background_exports = {};
__export(background_exports, {
  pickBackgroundImage: () => pickBackgroundImage,
  readBackgroundImage: () => readBackgroundImage
});
module.exports = __toCommonJS(background_exports);
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var import_electron2 = require("electron");

// src/main/wallpapers.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_electron = require("electron");

// src/shared/wallpaper.ts
var BUILTIN_WALLPAPER_PREFIX = "builtin:";
var WALLPAPER_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
function wallpaperIdOf(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
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
async function resolveBackgroundTarget(value) {
  if (!value.startsWith(BUILTIN_WALLPAPER_PREFIX)) return { ok: true, data: value };
  const id = builtinIdOf(value);
  if (id === null) return { ok: false, error: "\u5185\u7F6E\u58C1\u7EB8\u7684\u5F15\u7528\u4E0D\u5408\u6CD5" };
  const matched = (await scanWallpaperFiles()).find((entry) => entry.id === id);
  if (!matched) return { ok: false, error: "\u8FD9\u5F20\u5185\u7F6E\u58C1\u7EB8\u5DF2\u7ECF\u4E0D\u5728\u5B89\u88C5\u76EE\u5F55\u91CC\u4E86" };
  return { ok: true, data: matched.file };
}

// src/main/background.ts
var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
var MAX_SOURCE_BYTES = 30 * 1024 * 1024;
var MAX_EDGE = 1920;
var JPEG_QUALITY = 82;
async function pickBackgroundImage(parent) {
  const options = {
    title: "\u9009\u62E9\u5DE5\u4F5C\u533A\u80CC\u666F\u56FE",
    properties: ["openFile"],
    filters: [{ name: "\u56FE\u7247", extensions: IMAGE_EXTENSIONS }]
  };
  const result = parent ? await import_electron2.dialog.showOpenDialog(parent, options) : await import_electron2.dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}
async function readBackgroundImage(target) {
  const raw = typeof target === "string" ? target.trim() : "";
  if (!raw) return { ok: false, error: "\u8FD8\u6CA1\u6709\u9009\u62E9\u80CC\u666F\u56FE" };
  const resolved = await resolveBackgroundTarget(raw);
  if (!resolved.ok || !resolved.data) {
    return { ok: false, error: resolved.error ?? "\u80CC\u666F\u56FE\u4E0D\u5B58\u5728" };
  }
  const file = resolved.data;
  try {
    const stat = await import_node_fs2.promises.stat(file);
    if (!stat.isFile()) return { ok: false, error: "\u80CC\u666F\u56FE\u4E0D\u662F\u4E00\u4E2A\u6587\u4EF6" };
    if (stat.size > MAX_SOURCE_BYTES) {
      const limit = Math.round(MAX_SOURCE_BYTES / 1024 / 1024);
      return { ok: false, error: `\u56FE\u7247\u8D85\u8FC7 ${limit}MB\uFF0C\u8BF7\u6362\u4E00\u5F20\u5C0F\u4E00\u70B9\u7684` };
    }
  } catch {
    return { ok: false, error: "\u80CC\u666F\u56FE\u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9" };
  }
  const image = import_electron2.nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    return { ok: false, error: "\u8FD9\u5F20\u56FE\u7247\u89E3\u7801\u5931\u8D25\uFF0C\u8BF7\u6362 png / jpg / webp \u683C\u5F0F" };
  }
  const { width } = image.getSize();
  const scaled = width > MAX_EDGE ? image.resize({ width: MAX_EDGE, quality: "good" }) : image;
  return {
    ok: true,
    data: {
      // 回传原始值（路径或内置引用），设置里存的就是它，渲染层据此判断「是不是同一张」
      path: raw,
      name: (0, import_node_path2.basename)(file),
      dataUrl: `data:image/jpeg;base64,${scaled.toJPEG(JPEG_QUALITY).toString("base64")}`
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  pickBackgroundImage,
  readBackgroundImage
});
