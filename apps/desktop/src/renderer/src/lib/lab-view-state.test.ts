import { describe, expect, test } from "bun:test";
import {
  LAB_THRESHOLD_MAX,
  LAB_THRESHOLD_MIN,
  LAB_VIEW_DEFAULTS,
  LAB_VIEW_STORAGE_KEY,
  parseLabViewState,
  readLabViewState,
  serializeLabViewState,
  writeLabViewState,
} from "./lab-view-state";
import type { LabViewState } from "./lab-view-state";

const FULL: LabViewState = {
  sampleId: "sample-42",
  configA: "refine",
  configB: "baseline",
  threshold: 1.2,
  contentScrollTop: 120,
  rowsScrollTop: 640,
};

describe("serializeLabViewState / parseLabViewState", () => {
  test("往返：序列化后解析回同一份状态", () => {
    expect(parseLabViewState(serializeLabViewState(FULL))).toEqual(FULL);
  });

  test("字段顺序稳定，且只输出六个白名单字段", () => {
    expect(serializeLabViewState(LAB_VIEW_DEFAULTS)).toBe(
      '{"sampleId":null,"configA":"baseline","configB":"refine_filter","threshold":1,"contentScrollTop":0,"rowsScrollTop":0}',
    );
    expect(Object.keys(parseLabViewState(serializeLabViewState(FULL)))).toEqual([
      "sampleId",
      "configA",
      "configB",
      "threshold",
      "contentScrollTop",
      "rowsScrollTop",
    ]);
  });

  test("非法 JSON / 空串 / null / 非对象 / 数组：全部回默认值", () => {
    for (const raw of ["{not json", "", "   ", "null", "42", '"sample"', "true", "[]", "[1,2]"]) {
      expect(parseLabViewState(raw)).toEqual(LAB_VIEW_DEFAULTS);
    }
    expect(parseLabViewState(null)).toEqual(LAB_VIEW_DEFAULTS);
  });

  test("缺字段：逐个补默认值，不整份丢弃", () => {
    expect(parseLabViewState('{"sampleId":"s1"}')).toEqual({
      ...LAB_VIEW_DEFAULTS,
      sampleId: "s1",
    });
    expect(parseLabViewState("{}")).toEqual(LAB_VIEW_DEFAULTS);
  });

  test("未知方案名：A/B 独立回退，不影响另一个", () => {
    const onlyBUnknown = parseLabViewState('{"configA":"refine","configB":"refine2"}');
    expect(onlyBUnknown.configA).toBe("refine");
    expect(onlyBUnknown.configB).toBe("refine_filter");

    const onlyAUnknown = parseLabViewState('{"configA":"sherpa","configB":"refine"}');
    expect(onlyAUnknown.configA).toBe("baseline");
    expect(onlyAUnknown.configB).toBe("refine");

    const wrongType = parseLabViewState('{"configA":7,"configB":["refine"]}');
    expect(wrongType.configA).toBe("baseline");
    expect(wrongType.configB).toBe("refine_filter");
  });

  test("阈值：越界被 clamp 到滑块范围", () => {
    expect(parseLabViewState('{"threshold":0}').threshold).toBe(LAB_THRESHOLD_MIN);
    expect(parseLabViewState('{"threshold":-3}').threshold).toBe(LAB_THRESHOLD_MIN);
    expect(parseLabViewState('{"threshold":9}').threshold).toBe(LAB_THRESHOLD_MAX);
    expect(parseLabViewState('{"threshold":1.49}').threshold).toBe(1.5);
  });

  test("阈值：取 1 位小数，非数字回默认 1", () => {
    expect(parseLabViewState('{"threshold":1.234}').threshold).toBe(1.2);
    expect(parseLabViewState('{"threshold":1.26}').threshold).toBe(1.3);
    expect(parseLabViewState('{"threshold":0.62}').threshold).toBe(0.6);
    expect(parseLabViewState('{"threshold":0.95}').threshold).toBe(1);
    // clamp 先于取整：1.567 先被夹到 1.5
    expect(parseLabViewState('{"threshold":1.567}').threshold).toBe(1.5);
    for (const raw of ['{"threshold":"1.2"}', '{"threshold":null}', '{"threshold":true}', "{}"]) {
      expect(parseLabViewState(raw).threshold).toBe(1);
    }
    // JSON 里写不出 NaN/Infinity，走写入路径验证
    expect(parseLabViewState(serializeLabViewState({ ...FULL, threshold: NaN })).threshold).toBe(1);
    expect(
      parseLabViewState(serializeLabViewState({ ...FULL, threshold: Infinity })).threshold,
    ).toBe(1);
  });

  test("滚动位置：负数 / NaN / 字符串一律归零，小数向下取整", () => {
    const bad = parseLabViewState(
      '{"contentScrollTop":-5,"rowsScrollTop":"640"}',
    );
    expect(bad.contentScrollTop).toBe(0);
    expect(bad.rowsScrollTop).toBe(0);
    expect(parseLabViewState('{"contentScrollTop":null,"rowsScrollTop":false}')).toEqual(
      LAB_VIEW_DEFAULTS,
    );

    const floored = parseLabViewState('{"contentScrollTop":37.9,"rowsScrollTop":0.5}');
    expect(floored.contentScrollTop).toBe(37);
    expect(floored.rowsScrollTop).toBe(0);

    const written = serializeLabViewState({ ...FULL, contentScrollTop: 37.9, rowsScrollTop: -8 });
    expect(parseLabViewState(written).contentScrollTop).toBe(37);
    expect(parseLabViewState(written).rowsScrollTop).toBe(0);

    const nonFinite = serializeLabViewState({ ...FULL, contentScrollTop: NaN, rowsScrollTop: -0.4 });
    expect(parseLabViewState(nonFinite).contentScrollTop).toBe(0);
    expect(parseLabViewState(nonFinite).rowsScrollTop).toBe(0);
  });

  test("sampleId：空串 / 空白 / 非字符串归 null，两侧空白被裁掉", () => {
    expect(parseLabViewState('{"sampleId":""}').sampleId).toBeNull();
    expect(parseLabViewState('{"sampleId":"   "}').sampleId).toBeNull();
    expect(parseLabViewState('{"sampleId":42}').sampleId).toBeNull();
    expect(parseLabViewState('{"sampleId":"  sample-42  "}').sampleId).toBe("sample-42");
  });

  test("多余字段被丢弃，不会写回存储", () => {
    const raw =
      '{"sampleId":"s1","configA":"refine","configB":"refine","threshold":0.8,"contentScrollTop":1,"rowsScrollTop":2,"marks":{"0":"A"},"speakerFilter":"S1","cached":true}';
    const state = parseLabViewState(raw);
    expect(state).toEqual({
      sampleId: "s1",
      configA: "refine",
      configB: "refine",
      threshold: 0.8,
      contentScrollTop: 1,
      rowsScrollTop: 2,
    });
    expect(serializeLabViewState(state)).toBe(
      '{"sampleId":"s1","configA":"refine","configB":"refine","threshold":0.8,"contentScrollTop":1,"rowsScrollTop":2}',
    );
  });
});

describe("readLabViewState / writeLabViewState", () => {
  test("读写走同一个 storage key，读回与写入一致", () => {
    let writtenKey: string | null = null;
    let writtenValue: string | null = null;
    const storage = {
      getItem: (key: string) => (key === writtenKey ? writtenValue : null),
      setItem: (key: string, value: string) => {
        writtenKey = key;
        writtenValue = value;
      },
    };
    writeLabViewState(storage, FULL);
    expect(writtenKey).toBe(LAB_VIEW_STORAGE_KEY);
    expect(writtenValue).toBe(serializeLabViewState(FULL));
    expect(readLabViewState(storage)).toEqual(FULL);
  });

  test("storage 抛错时 readLabViewState 回退默认值", () => {
    const blocked = {
      getItem: (key: string): string | null => {
        throw new Error(`blocked: ${key}`);
      },
    };
    expect(readLabViewState(blocked)).toEqual(LAB_VIEW_DEFAULTS);
  });

  test("storage 为空或存了脏数据时回退默认值", () => {
    expect(readLabViewState({ getItem: () => null })).toEqual(LAB_VIEW_DEFAULTS);
    expect(readLabViewState({ getItem: () => "{broken" })).toEqual(LAB_VIEW_DEFAULTS);
  });

  test("writeLabViewState 写失败静默忽略，不抛给调用方", () => {
    const full = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeLabViewState(full, FULL)).not.toThrow();
  });
});
