import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({plugins:[react()],test:{environment:"node",include:["server/**/*.test.ts","core/**/*.test.ts","src/**/*.test.ts"]}});
