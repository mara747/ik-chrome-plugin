"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(require.resolve("../content/brokers/fio.js"), "utf8");

test("Fio offers scraping without requiring an e-mail in the page title", () => {
  let registered = null;
  const sandbox = {
    IK: { registerScraper(def) { registered = def; } },
    IKDiagnostics: {},
    location: {
      pathname: "/e-portfolio.cgi", search: "?menu=2",
    },
    document: { title: "Portfolio / Vývoj" },
    URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  assert.equal(registered.broker, "fio");
  assert.equal(registered.isPortfolioPage(), true);
});
