export function parseJsonWithoutDuplicateKeys(
  text: string,
  label: string,
): unknown {
  let index = 0;

  const fail = (reason: string): never => {
    throw new Error(`${label} is not strict JSON: ${reason}`);
  };
  const whitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const string = (): string => {
    if (text[index] !== '"') fail("expected a string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      if (character === "\\") {
        index += 1;
        const escape = text[index];
        if (!escape || !'"\\/bfnrtu'.includes(escape))
          fail("invalid string escape");
        if (escape === "u") {
          const code = text.slice(index + 1, index + 5);
          if (!/^[a-fA-F0-9]{4}$/u.test(code)) fail("invalid Unicode escape");
          index += 4;
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail("unescaped control character");
      }
      index += 1;
    }
    return fail("unterminated string");
  };
  const value = (): void => {
    whitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail("expected a colon");
        index += 1;
        value();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("expected a comma");
        index += 1;
      }
      fail("unterminated object");
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("expected a comma");
        index += 1;
      }
      fail("unterminated array");
    }
    if (character === '"') {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number === undefined) return fail("expected a JSON value");
    index += number.length;
  };

  value();
  whitespace();
  if (index !== text.length) fail("trailing content");
  return JSON.parse(text) as unknown;
}

export function assertSafeManifestStrings(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    if (/[\p{Cc}\p{Cf}]/u.test(value)) {
      throw new Error(
        `workflow manifest string ${path} contains control or format characters`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSafeManifestStrings(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertSafeManifestStrings(key, `${path}.<key>`);
      assertSafeManifestStrings(entry, `${path}.${key}`);
    }
  }
}
