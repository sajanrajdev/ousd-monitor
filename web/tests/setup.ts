import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

globalThis.fetch = () => {
  throw new Error("a test tried to use the network");
};

afterEach(cleanup);
