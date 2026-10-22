import { describe, expect, test } from "bun:test";
import {
  VOLCENGINE_FLASH_RESOURCE_ID,
  VOLCENGINE_FLASH_URL,
  VOLCENGINE_STANDARD_QUERY_URL,
  VOLCENGINE_STANDARD_RESOURCE_ID,
  VOLCENGINE_STANDARD_SUBMIT_URL,
} from "@video-notes/core";
import { VOLC_MODE_INFO } from "./volc";

describe("VOLC_MODE_INFO 与 core 协议常量一致", () => {
  test("flash endpoint/resourceId", () => {
    expect(VOLC_MODE_INFO.flash.endpoint).toBe(VOLCENGINE_FLASH_URL);
    expect(VOLC_MODE_INFO.flash.resourceId).toBe(VOLCENGINE_FLASH_RESOURCE_ID);
  });

  test("standard endpoint/queryEndpoint/resourceId", () => {
    expect(VOLC_MODE_INFO.standard.endpoint).toBe(VOLCENGINE_STANDARD_SUBMIT_URL);
    expect(VOLC_MODE_INFO.standard.queryEndpoint).toBe(VOLCENGINE_STANDARD_QUERY_URL);
    expect(VOLC_MODE_INFO.standard.resourceId).toBe(VOLCENGINE_STANDARD_RESOURCE_ID);
  });
});
