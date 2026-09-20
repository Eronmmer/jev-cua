export const FIXTURE_PATH = "/v1/catalog-search";
export const FIXTURE_V2_PATH = "/v2/catalog-search";
export const FIXTURE_V3_PATH = "/v3/catalog-search";
export const FIXTURE_V4_PATH = "/v4/catalog-search";
export const FIXTURE_V5_PATH = "/v5/catalog-search";
export const FIXTURE_V6_PATH = "/v6/catalog-search";

const SCRIPT = String.raw`(() => {
  "use strict";

  const catalog = Object.freeze([
    Object.freeze({ name: "Chicken thighs", price: 4.25, onSale: true }),
    Object.freeze({ name: "Chicken breast", price: 6.5, onSale: false }),
    Object.freeze({ name: "Chicken drumsticks", price: 3.75, onSale: true }),
    Object.freeze({ name: "Vegetable stock", price: 2.2, onSale: true })
  ]);
  const search = document.getElementById("search");
  const sort = document.getElementById("sort");
  const sale = document.getElementById("sale");
  const sortState = document.getElementById("sort-state");
  const saleState = document.getElementById("sale-state");
  const completionState = document.getElementById("completion-state");
  const results = document.getElementById("results");

  const render = () => {
    const query = search.value.trim().toLowerCase();
    const onSaleOnly = sale.checked;
    const products = catalog
      .filter((product) => product.name.toLowerCase().includes(query))
      .filter((product) => !onSaleOnly || product.onSale)
      .sort((left, right) =>
        sortState.value === "price_low" ? left.price - right.price : 0
      );

    results.replaceChildren(
      ...products.map((product) => {
        const item = document.createElement("li");
        item.textContent = product.name + " — £" + product.price.toFixed(2) +
          (product.onSale ? " — on sale" : "");
        return item;
      })
    );
    saleState.value = onSaleOnly ? "true" : "false";
    completionState.value =
      query === "chicken" &&
      sortState.value === "price_low" &&
      onSaleOnly
        ? "complete"
        : "incomplete";
  };

  search.addEventListener("input", render);
  sort.addEventListener("click", () => {
    sortState.value = "price_low";
    sort.setAttribute("aria-pressed", "true");
    render();
  });
  sale.addEventListener("change", render);
  render();
})();`;

export const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jev Cua catalog-search benchmark v1</title>
  <style>
    :root { color-scheme: light; font: 16px/1.45 system-ui, sans-serif; }
    body { margin: 0; background: #f4f6f8; color: #14212b; }
    main { width: min(760px, calc(100% - 40px)); margin: 40px auto; }
    .card { background: white; border: 1px solid #ccd6dd; border-radius: 14px; padding: 24px; box-shadow: 0 8px 30px #1232; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    .controls { display: grid; gap: 16px; margin: 24px 0; }
    label { display: grid; gap: 6px; font-weight: 650; }
    input[type="text"], button { font: inherit; padding: 10px 12px; border: 1px solid #8294a3; border-radius: 8px; }
    button { background: #eaf2ff; cursor: pointer; text-align: left; }
    .check { display: flex; align-items: center; gap: 10px; }
    .state { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .state label { font-size: .8rem; color: #52616d; }
    .state input { width: 100%; box-sizing: border-box; background: #f7f9fa; }
    ol { min-height: 110px; }
    small { color: #52616d; }
  </style>
</head>
<body>
  <main>
    <section class="card" aria-labelledby="benchmark-title">
      <h1 id="benchmark-title">Catalog-search quality check</h1>
      <p>Credential-free fixture: search, sort, and filter a local product catalog. Nothing can be submitted or purchased.</p>
      <div class="controls">
        <label for="search">Search products
          <input id="search" type="text" aria-label="Search products" autocomplete="off" spellcheck="false">
        </label>
        <button id="sort" type="button" aria-label="Sort by price low to high" aria-pressed="false">Sort by price: low to high</button>
        <label class="check" for="sale">
          <input id="sale" type="checkbox" aria-label="On sale only">
          On sale only
        </label>
      </div>
      <h2>Product results</h2>
      <ol id="results" aria-label="Product results"></ol>
      <div class="state" aria-label="Deterministic evaluator state">
        <label for="sort-state">Sort state
          <input id="sort-state" type="text" aria-label="Sort state" value="none" readonly>
        </label>
        <label for="sale-state">Sale filter state
          <input id="sale-state" type="text" aria-label="Sale filter state" value="false" readonly>
        </label>
        <label for="completion-state">Benchmark completion state
          <input id="completion-state" type="text" aria-label="Benchmark completion state" value="incomplete" readonly>
        </label>
      </div>
      <p><small>Version: JEV-CUA-CATALOG-SEARCH-V1. No forms, accounts, cookies, storage, analytics, or network requests.</small></p>
    </section>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;

export const FIXTURE_SCRIPT = SCRIPT;

export const FIXTURE_V2_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jev Cua catalog-search benchmark v2</title>
  <style>
    :root { color-scheme: light; font: 16px/1.35 system-ui, sans-serif; }
    body { margin: 0; background: #f4f6f8; color: #14212b; }
    main { width: min(760px, calc(100% - 32px)); margin: 16px auto; }
    .card { background: white; border: 1px solid #ccd6dd; border-radius: 14px; padding: 16px; box-shadow: 0 8px 30px #1232; }
    h1 { margin: 0; font-size: 1.5rem; }
    h2 { margin: 12px 0 4px; font-size: 1rem; }
    p { margin: 8px 0; }
    .controls { display: grid; gap: 8px; margin: 12px 0; }
    label { display: grid; gap: 4px; font-weight: 650; }
    input[type="text"], button { font: inherit; padding: 8px 10px; border: 1px solid #8294a3; border-radius: 8px; }
    button { background: #eaf2ff; cursor: pointer; text-align: left; }
    .check { display: flex; align-items: center; gap: 10px; }
    .state { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .state label { font-size: .8rem; color: #52616d; }
    .state input { width: 100%; box-sizing: border-box; background: #f7f9fa; }
    ol { min-height: 64px; margin: 4px 0 8px; }
    small { color: #52616d; }
  </style>
</head>
<body>
  <main>
    <section class="card" aria-labelledby="benchmark-title">
      <h1 id="benchmark-title">Catalog-search quality check</h1>
      <p>Credential-free fixture: search, sort, and filter a local product catalog. Nothing can be submitted or purchased.</p>
      <div class="controls">
        <label for="search">Search products
          <input id="search" type="text" aria-label="Search products" autocomplete="off" spellcheck="false">
        </label>
        <button id="sort" type="button" aria-label="Sort by price low to high" aria-pressed="false">Sort by price: low to high</button>
        <label class="check" for="sale">
          <input id="sale" type="checkbox" aria-label="On sale only">
          On sale only
        </label>
      </div>
      <div class="state" aria-label="Deterministic evaluator state">
        <label for="sort-state">Sort state
          <input id="sort-state" type="text" aria-label="Sort state" value="none" readonly>
        </label>
        <label for="sale-state">Sale filter state
          <input id="sale-state" type="text" aria-label="Sale filter state" value="false" readonly>
        </label>
        <label for="completion-state">Benchmark completion state
          <input id="completion-state" type="text" aria-label="Benchmark completion state" value="incomplete" readonly>
        </label>
      </div>
      <h2>Product results</h2>
      <ol id="results" aria-label="Product results"></ol>
      <p><small>Version: JEV-CUA-CATALOG-SEARCH-V2. No forms, accounts, cookies, storage, analytics, or application-initiated network requests.</small></p>
    </section>
  </main>
  <script>${SCRIPT}</script>
</body>
</html>`;

const V2_STATE_MARKUP = `      <div class="state" aria-label="Deterministic evaluator state">
        <label for="sort-state">Sort state
          <input id="sort-state" type="text" aria-label="Sort state" value="none" readonly>
        </label>
        <label for="sale-state">Sale filter state
          <input id="sale-state" type="text" aria-label="Sale filter state" value="false" readonly>
        </label>
        <label for="completion-state">Benchmark completion state
          <input id="completion-state" type="text" aria-label="Benchmark completion state" value="incomplete" readonly>
        </label>
      </div>`;

const V3_STATE_MARKUP = `      <div class="state" aria-label="Deterministic evaluator state">
        <label for="completion-state">Benchmark completion state
          <input id="completion-state" type="text" aria-label="Benchmark completion state" value="incomplete" readonly>
        </label>
        <label for="sort-state">Sort state
          <input id="sort-state" type="text" aria-label="Sort state" value="none" readonly>
        </label>
        <label for="sale-state">Sale filter state
          <input id="sale-state" type="text" aria-label="Sale filter state" value="false" readonly>
        </label>
      </div>`;

if (!FIXTURE_V2_HTML.includes(V2_STATE_MARKUP)) {
  throw new Error("catalog-search v2 state contract is missing");
}

export const FIXTURE_V3_HTML = FIXTURE_V2_HTML.replace(
  "catalog-search benchmark v2",
  "catalog-search benchmark v3",
)
  .replace(V2_STATE_MARKUP, V3_STATE_MARKUP)
  .replace("JEV-CUA-CATALOG-SEARCH-V2", "JEV-CUA-CATALOG-SEARCH-V3");

const V4_STATE_MARKUP = `      <div class="state" aria-label="Deterministic evaluator state">
        <label for="fixture-contract">Fixture contract
          <input id="fixture-contract" type="text" aria-label="Fixture contract" value="JEV-CUA-CATALOG-SEARCH-V4" readonly>
        </label>
        <label for="completion-state">Benchmark completion state
          <input id="completion-state" type="text" aria-label="Benchmark completion state" value="incomplete" readonly>
        </label>
        <label for="sort-state">Sort state
          <input id="sort-state" type="text" aria-label="Sort state" value="none" readonly>
        </label>
        <label for="sale-state">Sale filter state
          <input id="sale-state" type="text" aria-label="Sale filter state" value="false" readonly>
        </label>
      </div>`;

if (!FIXTURE_V3_HTML.includes(V3_STATE_MARKUP)) {
  throw new Error("catalog-search v3 state contract is missing");
}

export const FIXTURE_V4_HTML = FIXTURE_V3_HTML.replace(
  "catalog-search benchmark v3",
  "catalog-search benchmark v4",
)
  .replace(V3_STATE_MARKUP, V4_STATE_MARKUP)
  .replace("JEV-CUA-CATALOG-SEARCH-V3", "JEV-CUA-CATALOG-SEARCH-V4");

const V4_MAIN_LAYOUT =
  "main { width: min(760px, calc(100% - 32px)); margin: 16px auto; }";
const V5_MAIN_LAYOUT =
  "main { width: min(640px, calc(100% - 64px)); margin: 16px auto; }";

if (!FIXTURE_V4_HTML.includes(V4_MAIN_LAYOUT)) {
  throw new Error("catalog-search v4 layout contract is missing");
}

export const FIXTURE_V5_HTML = FIXTURE_V4_HTML.replace(
  "catalog-search benchmark v4",
  "catalog-search benchmark v5",
)
  .replace(V4_MAIN_LAYOUT, V5_MAIN_LAYOUT)
  .replaceAll("JEV-CUA-CATALOG-SEARCH-V4", "JEV-CUA-CATALOG-SEARCH-V5");

const V3_FIXTURE_DESCRIPTION =
  "      <p>Credential-free fixture: search, sort, and filter a local product catalog. Nothing can be submitted or purchased.</p>";
const V6_FIXTURE_DESCRIPTION = `${V3_FIXTURE_DESCRIPTION}
      <p><strong>Fixture contract: JEV-CUA-CATALOG-SEARCH-V6</strong></p>`;

for (const marker of [
  V3_FIXTURE_DESCRIPTION,
  'aria-label="Search products"',
  'aria-label="Sort by price low to high"',
  'aria-label="On sale only"',
]) {
  if (!FIXTURE_V3_HTML.includes(marker)) {
    throw new Error(`catalog-search v3 marker is missing: ${marker}`);
  }
}

export const FIXTURE_V6_HTML = FIXTURE_V3_HTML.replace(
  "catalog-search benchmark v3",
  "catalog-search benchmark v6",
)
  .replace(V3_FIXTURE_DESCRIPTION, V6_FIXTURE_DESCRIPTION)
  .replace(
    'aria-label="Search products"',
    'aria-label="Search products — JEV-CUA-CATALOG-SEARCH-V6"',
  )
  .replace(
    'aria-label="Sort by price low to high"',
    'aria-label="Sort by price low to high — JEV-CUA-CATALOG-SEARCH-V6"',
  )
  .replace(
    'aria-label="On sale only"',
    'aria-label="On sale only — JEV-CUA-CATALOG-SEARCH-V6"',
  )
  .replaceAll("JEV-CUA-CATALOG-SEARCH-V3", "JEV-CUA-CATALOG-SEARCH-V6");
