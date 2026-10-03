'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '../health-partner-geography.json');
const sources = {
  'American Samoa': [
    'https://tigerweb.geo.census.gov/tigerwebmain/Files/bas26/tigerweb_bas26_incplace_2020_tab20_as.html'
  ],
  Guam: [
    'https://tigerweb.geo.census.gov/tigerwebmain/Files/acs25/tigerweb_acs25_cdp_2020_tab20_gu.html'
  ],
  'Northern Mariana Islands': [
    'https://tigerweb.geo.census.gov/tigerwebmain/Files/acs26/tigerweb_acs26_incplace_2020_tab20_mp.html'
  ],
  'United States Virgin Islands': [
    'https://tigerweb.geo.census.gov/tigerwebmain/Files/acs25/tigerweb_acs25_incplace_2020_tab20_vi.html',
    'https://tigerweb.geo.census.gov/tigerwebmain/Files/acs25/tigerweb_acs25_cdp_2020_tab20_vi.html'
  ]
};

function decodeHtml(value) {
  return value.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function main() {
  const geography = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const [region, urls] of Object.entries(sources)) {
    const names = new Set(geography['États-Unis'][region] || []);
    for (const url of urls) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Census source failed (${response.status}): ${url}`);
      const html = await response.text();
      const placeNames = [...html.matchAll(/<td headers='header7'>(.*?)<\/td>/g)]
        .map((match) => decodeHtml(match[1].trim()))
        .filter((name) => name && name !== 'No data available');
      if (!placeNames.length) throw new Error(`No places found in Census source: ${url}`);
      placeNames.forEach((name) => names.add(name));
    }
    geography['États-Unis'][region] = [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  }
  geography._metadata.usTerritorySource = 'U.S. Census Bureau TIGERweb, Census 2020 incorporated-place and CDP tables; the Northern Mariana Islands list uses incorporated villages.';
  geography._metadata.builtAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(target, JSON.stringify(geography));
  for (const region of Object.keys(sources)) console.log(`${region}: ${geography['États-Unis'][region].length} localities`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
