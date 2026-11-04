// Shared JSON shape: expose `id`, hide Mongo internals and the owning user id.
export function toJSONPlugin(schema) {
  schema.set("toJSON", {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret) => {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.userId;
      return ret;
    },
  });
}
