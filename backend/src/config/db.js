import mongoose from "mongoose";
import { env } from "./env.js";

// Operator injection ({ "$ne": null } in a request) is blocked before queries are built:
// sanitizeInput strips $-prefixed keys and every route validates input types with zod.
mongoose.set("strictQuery", true);

export async function connectDB(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(`✅ MongoDB connected (${mongoose.connection.name})`);
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
