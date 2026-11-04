import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/**
 * Stream multipart "files" parts to temp files while hashing them, never buffering whole
 * uploads in memory. Sets req.uploadFiles = [{ originalName, tmpPath, size, sha256, truncated }]
 * and req.body to the text fields. Temp files are removed when the response ends.
 */
export function receiveResumeFiles(req, res, next) {
  if (!req.is("multipart/form-data")) return next(new AppError(400, "Upload files as multipart/form-data"));

  let bb;
  try {
    bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: env.resumeMaxBytes,
        files: env.RESUME_MAX_FILES_PER_UPLOAD,
        fields: 20,
        fieldSize: 4000,
        parts: env.RESUME_MAX_FILES_PER_UPLOAD + 20,
      },
    });
  } catch {
    return next(new AppError(400, "Malformed upload"));
  }

  const files = [];
  const fields = {};
  const writes = [];
  let tooManyFiles = false;
  let failed = false;

  const cleanup = () => Promise.all(files.map((f) => fsp.rm(f.tmpPath, { force: true }))).catch(() => {});
  res.on("close", cleanup);

  bb.on("file", (field, stream, info) => {
    if (field !== "files") {
      stream.resume();
      return;
    }
    const entry = {
      originalName: Buffer.from(info.filename ?? "", "latin1").toString("utf8"),
      tmpPath: path.join(os.tmpdir(), `mailflow-upload-${randomUUID()}`),
      size: 0,
      truncated: false,
    };
    files.push(entry);
    const hash = createHash("sha256");
    stream.on("data", (chunk) => {
      entry.size += chunk.length;
      hash.update(chunk);
    });
    stream.on("limit", () => {
      entry.truncated = true;
    });
    writes.push(
      pipeline(stream, fs.createWriteStream(entry.tmpPath)).then(() => {
        entry.sha256 = hash.digest("hex");
      }),
    );
  });
  bb.on("field", (name, value) => {
    fields[name] = value;
  });
  bb.on("filesLimit", () => {
    tooManyFiles = true;
  });
  bb.on("error", (err) => {
    failed = true;
    next(new AppError(400, `Upload failed: ${err.message}`));
  });
  bb.on("close", async () => {
    if (failed) return;
    try {
      await Promise.all(writes);
    } catch {
      return next(new AppError(400, "Upload was interrupted"));
    }
    if (tooManyFiles) {
      return next(new AppError(400, `Upload at most ${env.RESUME_MAX_FILES_PER_UPLOAD} files at a time`));
    }
    req.uploadFiles = files;
    req.body = fields;
    next();
  });

  req.pipe(bb);
}
