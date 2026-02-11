function sparqlQuery(year: number, month: number, day?: number): string {
  const dayFilter = typeof day === "number" ? ` && DAY(?deathDate) = ${day}` : "";

  const enwikiBlock = `
  ?enwiki schema:about ?person ;
         schema:isPartOf <https://en.wikipedia.org/> .
`;

  const enwikiFilter = REQUIRE_ENWIKI ? `FILTER(BOUND(?enwiki))` : ``;

  const notableBlock =
    MODE === "notable"
      ? `
  ?person wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${MIN_SITELINKS})
`
      : `
  OPTIONAL { ?person wikibase:sitelinks ?sitelinks . }
`;

  const violentBlock =
    MODE === "violent"
      ? `
  ?person wdt:P1196 ?mannerOfDeath .
  VALUES ?mannerOfDeath { ${valuesListQids(VIOLENT_MANNER_QIDS)} }
`
      : `
  OPTIONAL { ?person wdt:P1196 ?mannerOfDeath . }
`;

  return `
PREFIX schema: <http://schema.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX bd: <http://www.bigdata.com/rdf#>

SELECT
  ?person ?personLabel
  ?deathDate
  ?deathPlaceLabel ?deathCoord
  ?burialPlaceLabel ?burialCoord
  ?enwiki
  ?findAGraveId
  ?sitelinks
WHERE {
  ?person wdt:P31 wd:Q5 ;
          wdt:P570 ?deathDate .

  # Exclude fictional characters (and anything that is a subclass of fictional character)
  FILTER NOT EXISTS { ?person wdt:P31/wdt:P279* wd:Q95074 . }

  FILTER(YEAR(?deathDate) = ${year} && MONTH(?deathDate) = ${month}${dayFilter})

  ${notableBlock}
  ${violentBlock}

  OPTIONAL {
    ?person wdt:P20 ?deathPlace .
    ?deathPlace wdt:P625 ?deathCoord .
    ?deathPlace rdfs:label ?deathPlaceLabel .
    FILTER(LANG(?deathPlaceLabel) = "en")
  }

  OPTIONAL {
    ?person wdt:P119 ?burialPlace .
    ?burialPlace wdt:P625 ?burialCoord .
    ?burialPlace rdfs:label ?burialPlaceLabel .
    FILTER(LANG(?burialPlaceLabel) = "en")
  }

  OPTIONAL { ?person wdt:P535 ?findAGraveId . }

  OPTIONAL {
${enwikiBlock}
  }

  ${enwikiFilter}

  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;
}
