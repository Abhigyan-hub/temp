import { AppError } from "../utils/AppError.js";

/** Validate req.body / req.query / req.params with zod schemas. Parsed values replace the input. */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    try {
      if (params) req.params = params.parse(req.params);
      if (query) req.validatedQuery = query.parse(req.query);
      if (body) req.body = body.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err?.issues) {
        const details = err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
        return next(new AppError(400, details[0]?.message ?? "Invalid request", details));
      }
      next(err);
    }
  };
