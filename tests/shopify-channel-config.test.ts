import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const extensionConfig = readFileSync(
  resolve(process.cwd(), "extensions/channel-config/shopify.extension.toml"),
  "utf8",
);
const channelSpec = readFileSync(
  resolve(
    process.cwd(),
    "extensions/channel-config/specifications/aura-historia.toml",
  ),
  "utf8",
);
const apiTypes = readFileSync(
  resolve(process.cwd(), "app/generated/api/types.gen.ts"),
  "utf8",
);
const specificationDir = resolve(
  process.cwd(),
  "extensions/channel-config/specifications",
);
const iconPath = resolve(specificationDir, "aura-historia-channel-icon.svg");
const icon = readFileSync(iconPath, "utf8");

const SHOPIFY_COUNTRY_CODES = [
  "AC",
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AR",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PS",
  "PT",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TA",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VN",
  "VU",
  "WF",
  "WS",
  "XK",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
];

function readStringUnion(typeName: string) {
  const match = new RegExp(`export type ${typeName} = ([^;]+);`).exec(apiTypes);

  assert.ok(match, `${typeName} union should exist in generated API types`);

  return Array.from(match[1].matchAll(/'([^']+)'/g), ([, value]) => value);
}

function parseChannelCountries() {
  return Array.from(
    channelSpec.matchAll(
      /\[\[countries\]\]\s+code = "([^"]+)"\s+languages = \[([^\]]+)\]\s+currency = "([^"]+)"/g,
    ),
    ([, code, rawLanguages, currency]) => ({
      code,
      languages: Array.from(
        rawLanguages.matchAll(/"([^"]+)"/g),
        ([, language]) => language,
      ),
      currency,
    }),
  );
}

const apiLanguages = readStringUnion("LanguageData");
const apiCurrencies = readStringUnion("CurrencyData");
const countryEntries = parseChannelCountries();

describe("Shopify sales channel config extension", () => {
  it("declares the Shopify channel_config extension", () => {
    assert.match(extensionConfig, /type = "channel_config"/);
    assert.match(extensionConfig, /handle = "channel-config"/);
    assert.match(extensionConfig, /name = "Aura Historia channel config"/);
    assert.match(
      extensionConfig,
      /create_legacy_channel_on_app_install = false/,
    );
  });

  it("describes Aura Historia as an automatic product discovery channel", () => {
    assert.match(channelSpec, /handle = "aura-historia"/);
    assert.match(channelSpec, /label = "Aura Historia"/);
    assert.match(channelSpec, /icon = "aura-historia-channel-icon\.svg"/);
    assert.match(channelSpec, /productFeedManagement = "automatic"/);
  });

  it("keeps traffic-driving sales channel requirements explicit", () => {
    assert.match(channelSpec, /expectsOnlineStoreParity = true/);
    assert.match(channelSpec, /merchantOfRecord = "merchant"/);
  });

  it("makes conservative capability claims", () => {
    for (const capability of [
      "bundles",
      "digitalProducts",
      "subscriptions",
      "combinedListings",
      "scheduledPublishing",
    ]) {
      assert.match(channelSpec, new RegExp(`${capability} = false`));
    }
  });

  it("declares every concrete Shopify country or region code", () => {
    assert.equal(countryEntries.length, SHOPIFY_COUNTRY_CODES.length);
    assert.deepEqual(
      countryEntries.map((entry) => entry.code).sort(),
      [...SHOPIFY_COUNTRY_CODES].sort(),
    );
    assert.equal(
      new Set(countryEntries.map((entry) => entry.code)).size,
      SHOPIFY_COUNTRY_CODES.length,
    );
  });

  it("declares every backend-supported language for each country", () => {
    assert.deepEqual(apiLanguages, [
      "de",
      "en",
      "fr",
      "es",
      "it",
      "zh",
      "pt",
      "pl",
      "tr",
      "nl",
      "cs",
      "ja",
      "ru",
      "ar",
    ]);

    for (const entry of countryEntries) {
      assert.deepEqual(entry.languages, apiLanguages);
    }
  });

  it("uses every backend-supported currency and no unsupported currencies", () => {
    const declaredCurrencies = new Set(
      countryEntries.map((entry) => entry.currency),
    );

    assert.deepEqual([...declaredCurrencies].sort(), [...apiCurrencies].sort());
  });

  it("does not keep generated example channel specifications", () => {
    const specificationFiles = readdirSync(specificationDir).filter((file) =>
      file.startsWith("example"),
    );
    const iconFiles = readdirSync(specificationDir).filter(
      (file) => file.startsWith("example") && file.endsWith(".svg"),
    );

    assert.deepEqual(specificationFiles, []);
    assert.deepEqual(iconFiles, []);
  });
});
