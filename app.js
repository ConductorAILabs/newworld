/* ============================================================
   A New World Dashboard v2 — Tabbed Interface Application
   Polls /api/state every 5 seconds and renders all panels.
   All DOM construction uses textContent or createElement.
   ============================================================ */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var POLL_INTERVAL = 5000;
  var HISTORY_SIZE = 100;
  var FEED_MAX = 100;

  // API key — read from meta tag or URL param ?key=...
  var API_KEY = (function() {
    var meta = document.querySelector('meta[name="api-key"]');
    if (meta) return meta.getAttribute("content");
    var params = new URLSearchParams(window.location.search);
    return params.get("key") || "";
  })();

  function apiFetch(url) {
    var opts = {};
    if (API_KEY) {
      opts.headers = { "x-api-key": API_KEY };
    }
    return fetch(url, opts);
  }
  var MAP_W = 50000;
  var MAP_H = 40000;
  var ENV_COLS = 1000;  // tiles across (50 world units per tile)
  var ENV_ROWS = 800;   // tiles down
  var TILE_PX = 50;     // world units per tile

  // ---------------------------------------------------------------------------
  // Logging & Diagnostics
  // ---------------------------------------------------------------------------

  var LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  var currentLogLevel = LOG_LEVEL.DEBUG;
  var pollCount = 0;
  var lastPollMs = 0;
  var errorCounts = {};
  var _prevSharedLexicon = [];
  var _prevDeaths = [];

  function log(level, tag, msg, data) {
    if (level < currentLogLevel) return;
    var prefix = ["[DEBUG]", "[INFO]", "[WARN]", "[ERROR]"][level] || "[?]";
    var ts = new Date().toISOString().slice(11, 23);
    var line = ts + " " + prefix + " [" + tag + "] " + msg;
    if (level >= LOG_LEVEL.ERROR) {
      console.error(line, data !== undefined ? data : "");
    } else if (level >= LOG_LEVEL.WARN) {
      console.warn(line, data !== undefined ? data : "");
    } else {
      console.log(line, data !== undefined ? data : "");
    }
  }

  function trackError(tag) {
    errorCounts[tag] = (errorCounts[tag] || 0) + 1;
  }

  // Safe wrapper — runs fn inside try/catch, logs errors, returns fallback
  function safe(tag, fn, fallback) {
    try {
      return fn();
    } catch (err) {
      trackError(tag);
      log(LOG_LEVEL.ERROR, tag, err.message, { stack: err.stack });
      return fallback !== undefined ? fallback : undefined;
    }
  }

  // Validate expected shape of an object — logs warnings for missing keys
  function validateShape(tag, obj, requiredKeys) {
    if (!obj || typeof obj !== "object") {
      log(LOG_LEVEL.WARN, tag, "Expected object, got " + typeof obj);
      return false;
    }
    var missing = [];
    requiredKeys.forEach(function (k) {
      if (obj[k] === undefined || obj[k] === null) missing.push(k);
    });
    if (missing.length > 0) {
      log(LOG_LEVEL.DEBUG, tag, "Missing keys: " + missing.join(", "));
    }
    return missing.length === 0;
  }

  // Check if an array is non-empty, log if empty
  function checkArray(tag, arr, name) {
    if (!Array.isArray(arr)) {
      log(LOG_LEVEL.WARN, tag, name + " is not an array: " + typeof arr);
      return false;
    }
    if (arr.length === 0) {
      log(LOG_LEVEL.DEBUG, tag, name + " is empty");
      return false;
    }
    return true;
  }

  // Planetary model — Y=0 North Pole, Y=20000 Equator, Y=40000 South Pole
  var LANDMARKS = {
    // Home territory (equatorial zone)
    fire_pit            : { x: 25000, y: 20000, label: "Fire Pit" },
    shelter             : { x: 24800, y: 19800, label: "Shelter" },
    stone_circle        : { x: 25500, y: 19500, label: "Stone Circle" },
    // Equatorial zone (Y: 14000-26000) — tropical
    deep_forest         : { x:  8000, y: 18000, label: "Deep Forest" },
    old_tree            : { x:  6000, y: 20000, label: "Old Tree" },
    mushroom_grove      : { x: 10000, y: 22000, label: "Mushroom Grove" },
    ancient_grove       : { x:  5000, y: 21000, label: "Ancient Grove" },
    forest_clearing     : { x: 12000, y: 19000, label: "Forest Clearing" },
    forest_edge         : { x: 14000, y: 17000, label: "Forest Edge" },
    river_upper         : { x: 20000, y: 14500, label: "River Upper" },
    river_bend          : { x: 24000, y: 17000, label: "River Bend" },
    river               : { x: 30000, y: 20000, label: "River" },
    river_delta         : { x: 48000, y: 20000, label: "River Delta" },
    south_river         : { x: 20000, y: 25500, label: "South River" },
    south_river_lower   : { x: 30000, y: 23000, label: "South River Lower" },
    south_delta         : { x: 48000, y: 22000, label: "South Delta" },
    lake_te_anau        : { x: 15000, y: 19000, label: "Lake Te Anau" },
    lake_wakatipu       : { x: 18000, y: 21000, label: "Lake Wakatipu" },
    lake_hawea          : { x: 35000, y: 19000, label: "Lake Hawea" },
    lake_wanaka         : { x: 32000, y: 21500, label: "Lake Wanaka" },
    meadow              : { x: 30000, y: 18000, label: "Meadow" },
    berry_grove         : { x: 28000, y: 22000, label: "Berry Grove" },
    great_plain         : { x: 36000, y: 20000, label: "Great Plain" },
    flower_field        : { x: 22000, y: 21000, label: "Flower Field" },
    beach               : { x: 48500, y: 20000, label: "Beach" },
    tide_pools          : { x: 48000, y: 22000, label: "Tide Pools" },
    east_port           : { x: 48000, y: 19000, label: "East Port" },
    rocky_shore         : { x:  1500, y: 20000, label: "Rocky Shore" },
    hot_spring          : { x: 40000, y: 20000, label: "Hot Spring" },
    geyser              : { x: 42000, y: 19000, label: "Geyser" },
    // Northern temperate (Y: 6000-14000) — highlands, conifer
    summit              : { x: 20000, y: 10000, label: "Summit" },
    north_peak          : { x: 15000, y:  8000, label: "North Peak" },
    mountain_pass       : { x: 18000, y: 11000, label: "Mountain Pass" },
    eagle_nest          : { x: 22000, y:  9000, label: "Eagle Nest" },
    hilltop             : { x: 25000, y: 12000, label: "Hilltop" },
    cave                : { x: 16000, y: 10000, label: "Cave" },
    cave_deep           : { x: 14000, y: 12000, label: "Cave Deep" },
    milford             : { x:  8000, y: 10000, label: "Milford" },
    doubtful            : { x: 10000, y: 12000, label: "Doubtful" },
    waterfall           : { x: 18000, y:  8000, label: "Waterfall" },
    west_river          : { x: 12000, y: 10000, label: "West River" },
    lookout             : { x: 28000, y: 11000, label: "Lookout" },
    cove                : { x: 48000, y: 10000, label: "Cove" },
    // Southern temperate (Y: 26000-34000) — arid, desert
    golden_field        : { x: 35000, y: 28000, label: "Golden Field" },
    dry_plain           : { x: 30000, y: 30000, label: "Dry Plain" },
    tussock             : { x: 25000, y: 29000, label: "Tussock" },
    dry_valley          : { x: 28000, y: 31000, label: "Dry Valley" },
    red_rocks           : { x: 35000, y: 32000, label: "Red Rocks" },
    cliffs              : { x: 45000, y: 28000, label: "Cliffs" },
    south_ridge         : { x: 20000, y: 30000, label: "South Ridge" },
    south_cave          : { x: 18000, y: 32000, label: "South Cave" },
    dusky               : { x:  2000, y: 30000, label: "Dusky" },
    preservation        : { x:  4000, y: 32000, label: "Preservation" },
    // North pole (Y: 0-6000) — ice, tundra
    glacier_fox         : { x: 15000, y:  3000, label: "Glacier Fox" },
    glacier_franz       : { x: 20000, y:  2000, label: "Glacier Franz" },
    frozen_lake         : { x: 25000, y:  4000, label: "Frozen Lake" },
    ice_field           : { x: 30000, y:  2000, label: "Ice Field" },
    west_beach          : { x:  5000, y:  3000, label: "West Beach" },
    river_mouth_west    : { x: 10000, y:  5000, label: "River Mouth West" },
    // South pole (Y: 34000-40000) — ice, tundra
    marsh               : { x: 15000, y: 36000, label: "Marsh" },
    bog                 : { x: 20000, y: 37000, label: "Bog" },
    reed_bed            : { x: 25000, y: 36000, label: "Reed Bed" },
    still_water         : { x: 30000, y: 38000, label: "Still Water" },
    west_coast          : { x:  5000, y: 37000, label: "West Coast" },
  };

  // Planetary biomes — latitude bands
  var BIOMES = {
    // North pole (Y: 0-6000)
    tundra_north        : { cx: 25000, cy:  2000, r: 15000 },
    ice_north           : { cx: 15000, cy:  1000, r:  8000 },
    ice_north_east      : { cx: 38000, cy:  3000, r:  8000 },
    // Northern boreal (Y: 6000-9000)
    boreal_north        : { cx: 25000, cy:  7500, r: 12000 },
    // Northern temperate (Y: 9000-14000)
    highlands           : { cx: 20000, cy: 10000, r:  6000 },
    forest_conifer      : { cx: 10000, cy: 11000, r:  5000 },
    forest_conifer_east : { cx: 35000, cy: 12000, r:  5000 },
    meadow_alpine       : { cx: 28000, cy: 11000, r:  4000 },
    // Equatorial zone (Y: 14000-26000)
    tropical_forest     : { cx:  8000, cy: 19000, r:  6000 },
    tropical_forest_east: { cx: 42000, cy: 20000, r:  5000 },
    grassland           : { cx: 33000, cy: 19000, r:  6000 },
    meadow              : { cx: 25000, cy: 20000, r:  5000 },
    river_valley        : { cx: 20000, cy: 18000, r:  4000 },
    wetlands            : { cx: 15000, cy: 22000, r:  3500 },
    hot_springs         : { cx: 41000, cy: 20000, r:  2500 },
    coast_east          : { cx: 48500, cy: 20000, r:  2000 },
    coast_west          : { cx:  1500, cy: 20000, r:  2000 },
    // Southern arid (Y: 26000-34000)
    desert              : { cx: 30000, cy: 30000, r:  7000 },
    savanna             : { cx: 20000, cy: 28000, r:  5000 },
    scrubland           : { cx: 40000, cy: 29000, r:  5000 },
    cliffs_south        : { cx: 45000, cy: 31000, r:  3000 },
    // Southern boreal (Y: 34000-37000)
    boreal_south        : { cx: 25000, cy: 35500, r: 12000 },
    // South pole (Y: 37000-40000)
    tundra_south        : { cx: 25000, cy: 38000, r: 15000 },
    ice_south           : { cx: 15000, cy: 39000, r:  8000 },
    ice_south_east      : { cx: 38000, cy: 39000, r:  8000 },
  };

  var CITIZEN_COLORS = {
    male:   { base: "#5a9bba", glow: "rgba(90,155,186,0.4)" },
    female: { base: "#d4a574", glow: "rgba(212,165,116,0.4)" }
  };

  // ---------------------------------------------------------------------------
  // Map layer toggles
  // ---------------------------------------------------------------------------
  var mapLayers = { labels: true, animals: true, speech: true, trails: false, food: false, grid: false };
  var feedFilter = "all";

  window.setFeedFilter = function(filter) {
    feedFilter = filter;
    // Update button states
    var btns = document.querySelectorAll(".feed-filter");
    btns.forEach(function(b) { b.classList.toggle("active", b.getAttribute("data-filter") === filter); });
    // Show/hide entries
    var entries = document.querySelectorAll(".feed-entry");
    entries.forEach(function(e) {
      if (filter === "all") { e.style.display = ""; return; }
      e.style.display = e.classList.contains("type-" + filter) ? "" : "none";
    });
  };
  var mapView = "terrain"; // "terrain", "social", "resources", "danger"

  window.setMapView = function(view) {
    mapView = view;
    // Update button states
    ["terrain", "social", "resources", "danger", "language"].forEach(function(v) {
      var btn = byId("view-" + v);
      if (btn) btn.classList.toggle("active", v === view);
    });
    // Auto-toggle layers based on view
    if (view === "terrain") {
      mapLayers.labels = true; mapLayers.animals = true; mapLayers.speech = true;
    } else if (view === "social") {
      mapLayers.labels = true; mapLayers.animals = false; mapLayers.speech = true;
    } else if (view === "resources") {
      mapLayers.labels = true; mapLayers.animals = true; mapLayers.speech = false;
    } else if (view === "danger") {
      mapLayers.labels = false; mapLayers.animals = true; mapLayers.speech = false;
    } else if (view === "language") {
      mapLayers.labels = true; mapLayers.animals = false; mapLayers.speech = false;
    }
    // Update show toggles
    ["labels", "animals", "speech"].forEach(function(l) {
      var btn = byId("toggle-" + l);
      if (btn) btn.classList.toggle("active", mapLayers[l]);
    });
    // Force terrain redraw for view-specific overlays
    terrainCacheSeason = null;
  };

  window.toggleMapLayer = function(layer) {
    mapLayers[layer] = !mapLayers[layer];
    var btn = byId("toggle-" + layer);
    if (btn) btn.classList.toggle("active", mapLayers[layer]);
    // Force terrain recache if grid toggled
    if (layer === "grid" || layer === "trails" || layer === "food") terrainCacheSeason = null;
  };

  // ---------------------------------------------------------------------------
  // Map zoom/pan state
  // ---------------------------------------------------------------------------
  var mapZoom = 1.0;
  var mapPanX = 0;
  var mapPanY = 0;
  var mapDragging = false;
  var mapDragStartX = 0;
  var mapDragStartY = 0;
  var mapPanStartX = 0;
  var mapPanStartY = 0;
  var terrainCanvas = null;       // offscreen canvas for cached terrain (200x150)
  var terrainGrid = null;         // 200x150 array of tile objects
  var terrainCacheSeason = null;  // cache key: season
  var terrainCacheTime = null;    // cache key: time_of_day
  var terrainCacheWeather = null; // cache key: weather
  var minimapCanvas = null;       // offscreen minimap canvas (80x60)
  var mapMouseX = -1;             // mouse position on map canvas (CSS px, -1 = off)
  var mapMouseY = -1;

  // ---------------------------------------------------------------------------
  // Terrain Generation — Pixel-art per-tile renderer (200x150 grid)
  // ---------------------------------------------------------------------------

  function dist(x1, y1, x2, y2) {
    var dx = x1 - x2, dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Distance from point (px,py) to the line segment (ax,ay)-(bx,by)
  function distToSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return dist(px, py, ax, ay);
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return dist(px, py, ax + t * dx, ay + t * dy);
  }

  function generateTerrainMap() {
    // Seeded PRNG for deterministic results
    var seed = 42;
    function rand() { seed = (seed * 16807 + 0) % 2147483647; return (seed - 1) / 2147483646; }

    // NORTH RIVER — flows from northern mountains south toward equator (east side)
    var riverPts = [
      { x: 18000, y:  8000 },  // glacier melt (waterfall)
      { x: 20000, y: 14500 },  // river upper
      { x: 24000, y: 17000 },  // river bend
      { x: 30000, y: 20000 },  // equatorial river
      { x: 48000, y: 20000 },  // east coast delta
    ];
    // NORTH RIVER WEST — flows from northern mountains south toward equator (west side)
    var riverPts2 = [
      { x: 12000, y: 10000 },  // west river start
      { x: 10000, y: 14000 },  // through conifer forest
      { x:  8000, y: 18000 },  // into tropical zone
      { x:  1500, y: 20000 },  // west coast
    ];
    // SOUTH RIVER — flows from southern equatorial zone into arid south
    var riverPts3 = [
      { x: 20000, y: 25500 },  // south river start
      { x: 30000, y: 23000 },  // south river lower
      { x: 48000, y: 22000 },  // south delta
    ];
    // CROSS-EQUATORIAL RIVER — connects lakes near equator
    var riverPts4 = [
      { x: 15000, y: 19000 },  // Lake Te Anau
      { x: 18000, y: 21000 },  // Lake Wakatipu
      { x: 25000, y: 20000 },  // fire pit area
      { x: 32000, y: 21500 },  // Lake Wanaka
      { x: 35000, y: 19000 },  // Lake Hawea
    ];
    var allRivers = [riverPts, riverPts2, riverPts3, riverPts4];

    terrainGrid = [];
    for (var r = 0; r < ENV_ROWS; r++) {
      terrainGrid[r] = [];
      for (var c = 0; c < ENV_COLS; c++) {
        var worldX = c * TILE_PX + TILE_PX / 2;
        var worldY = r * TILE_PX + TILE_PX / 2;

        // Latitude factor: 0 at equator (Y=20000), 1 at poles (Y=0 or Y=40000)
        var latFactor = Math.abs(worldY - 20000) / 20000;

        // Multi-octave noise for organic, natural-looking terrain edges
        var n1 = Math.sin(worldX * 0.00015 + worldY * 0.00023 + 3.7) * 0.4;
        var n2 = Math.sin(worldX * 0.00047 - worldY * 0.00031 + 1.2) * 0.25;
        var n3 = Math.sin(worldX * 0.00091 + worldY * 0.00067 + 5.1) * 0.15;
        var n4 = Math.sin(worldX * 0.0019 - worldY * 0.0013 + 2.8) * 0.1;
        var noise = n1 + n2 + n3 + n4; // -0.9 to +0.9
        var noisyLat = latFactor + noise * 0.08; // wobble the latitude boundary

        // LATITUDE-FIRST biome assignment — prevents impossible transitions
        // Desert can NEVER touch tundra. Tropical can NEVER touch ice.
        // Within each band, use biome centers for east-west variation.
        var latBand;
        if (noisyLat > 0.88) latBand = "ice";
        else if (noisyLat > 0.75) latBand = "tundra";
        else if (noisyLat > 0.60) latBand = "boreal";
        else if (noisyLat > 0.42) latBand = "temperate";
        else if (noisyLat > 0.22) latBand = "subtropical";
        else latBand = "tropical";

        // Within the latitude band, find the closest biome center
        // Only consider biomes that belong to this band
        var bandBiomes = {
          "ice": ["ice_north", "ice_north_east", "ice_south", "ice_south_east"],
          "tundra": ["tundra_north", "tundra_south"],
          "boreal": ["boreal_north", "boreal_south", "forest_conifer", "forest_conifer_east"],
          "temperate": ["highlands", "meadow_alpine", "forest_conifer", "forest_conifer_east"],
          "subtropical": ["grassland", "desert", "savanna", "scrubland", "cliffs_south"],
          "tropical": ["tropical_forest", "tropical_forest_east", "grassland", "meadow", "river_valley", "wetlands", "hot_springs", "coast_east", "coast_west"],
        };

        var candidates = bandBiomes[latBand] || ["grassland"];
        var closestBiome = candidates[0] || "grassland";
        var closestDist = Infinity;
        var secondBiome = closestBiome;
        var secondDist = Infinity;

        for (var ci = 0; ci < candidates.length; ci++) {
          var bk = candidates[ci];
          var b = BIOMES[bk];
          if (!b) continue;
          var d = dist(worldX, worldY, b.cx, b.cy);
          var nd = d / b.r + noise * 0.2;
          if (nd < closestDist) {
            secondBiome = closestBiome;
            secondDist = closestDist;
            closestDist = nd;
            closestBiome = bk;
          } else if (nd < secondDist) {
            secondDist = nd;
            secondBiome = bk;
          }
        }
        // blendFactor: 0 = deep inside closest biome, 1 = right at boundary
        var blendRange = 0.4; // how wide the transition zone is
        var blendFactor = closestDist > 1.0 - blendRange ? Math.min(1, (closestDist - (1.0 - blendRange)) / blendRange) : 0;
        // Add extra noise to the blend
        blendFactor = Math.max(0, Math.min(1, blendFactor + (rand() - 0.5) * 0.15));

        // River distance — minimum distance to any river segment
        var riverDist = Infinity;
        for (var riv = 0; riv < allRivers.length; riv++) {
          var pts = allRivers[riv];
          for (var ri = 0; ri < pts.length - 1; ri++) {
            var rd = distToSegment(worldX, worldY, pts[ri].x, pts[ri].y, pts[ri + 1].x, pts[ri + 1].y);
            if (rd < riverDist) riverDist = rd;
          }
        }

        // River width — scaled for 50000x40000 world
        var riverWidth = 300 + rand() * 200;

        // Determine tile properties
        var isWater = false;
        var isForest = false;
        var isRock = false;
        var isMeadow = false;
        var isWetland = false;
        var isTundra = false;
        var isDesert = false;
        var isCoast = false;
        var isIce = false;
        var isTropical = false;
        var isSavanna = false;
        var isBoreal = false;
        var elevation = 0.5;

        // Water: river system (no rivers at poles — they freeze)
        if (riverDist < riverWidth && latFactor < 0.85) {
          isWater = true;
        }

        // Water near landmarks — equatorial lakes, wetlands
        var waterChecks = [
          [15000, 19000, 1500],  // Lake Te Anau
          [18000, 21000, 1200],  // Lake Wakatipu
          [35000, 19000, 1000],  // Lake Hawea
          [32000, 21500, 1100],  // Lake Wanaka
          [25000,  4000, 800],   // Frozen Lake (north pole)
          [30000, 38000, 1000],  // Still Water (south pole, frozen)
          [48000, 22000, 800],   // Tide pools
          [48000, 20000, 600],   // East port/delta
          [40000, 20000, 600],   // Hot spring
          [15000, 22000, 1000],  // Wetlands
        ];
        for (var wi = 0; wi < waterChecks.length; wi++) {
          var wc = waterChecks[wi];
          if (dist(worldX, worldY, wc[0], wc[1]) < wc[2] + rand() * (wc[2] * 0.3)) isWater = true;
        }
        // West coast ocean
        if (worldX < 1200 + rand() * 400) isWater = true;
        // East coast ocean
        if (worldX > 49200 - rand() * 400) isWater = true;

        // River valley center has water
        if (closestBiome === "river_valley" && closestDist < 0.3 + rand() * 0.1) isWater = true;

        // Latitude-driven biome assignment (primary driver)
        var biomeKey = closestBiome;

        // Ice/tundra at poles
        if (biomeKey.indexOf("ice") === 0) {
          isIce = true;
          isTundra = true;
          elevation = 0.3;
          if (rand() < 0.05) isWater = true;
        } else if (biomeKey.indexOf("tundra") === 0) {
          isTundra = true;
          elevation = 0.4;
          if (rand() < 0.05) isWater = true;
        } else if (biomeKey.indexOf("boreal") === 0) {
          isBoreal = true;
          elevation = 0.45;
        } else if (biomeKey === "highlands") {
          isRock = true;
          elevation = 0.85;
        } else if (biomeKey.indexOf("forest_conifer") === 0) {
          isForest = true;
          elevation = 0.55;
        } else if (biomeKey === "meadow_alpine") {
          isMeadow = true;
          elevation = 0.5;
        } else if (biomeKey.indexOf("tropical") === 0) {
          isTropical = true;
          isForest = true;
          elevation = 0.4;
        } else if (biomeKey === "grassland") {
          isMeadow = true;
          elevation = 0.4;
        } else if (biomeKey === "meadow") {
          isMeadow = true;
          elevation = 0.35;
        } else if (biomeKey === "river_valley") {
          elevation = 0.2;
          if (!isWater) isWetland = rand() < 0.2;
        } else if (biomeKey === "wetlands") {
          isWetland = true;
          elevation = 0.2;
          if (rand() < 0.15) isWater = true;
        } else if (biomeKey === "hot_springs") {
          elevation = 0.3;
          if (rand() < 0.08) isWater = true;
        } else if (biomeKey === "desert") {
          isDesert = true;
          elevation = 0.35;
        } else if (biomeKey === "savanna") {
          isSavanna = true;
          elevation = 0.4;
        } else if (biomeKey === "scrubland") {
          isSavanna = true;
          isDesert = true;
          elevation = 0.4;
        } else if (biomeKey === "cliffs_south") {
          isRock = true;
          elevation = 0.7;
        } else if (biomeKey.indexOf("coast") === 0) {
          isCoast = true;
          elevation = 0.1;
          if (rand() < 0.2) isWater = true;
        }

        // Rock areas — mountain peaks, caves
        var rockChecks = [
          [16000, 10000, 1200],  // Cave
          [14000, 12000, 1000],  // Cave deep
          [20000, 10000, 1500],  // Summit
          [15000,  8000, 1200],  // North peak
          [18000, 32000, 1000],  // South cave
          [20000, 30000, 1200],  // South ridge
          [15000,  3000, 800],   // Glacier Fox
          [20000,  2000, 800],   // Glacier Franz
        ];
        for (var rci = 0; rci < rockChecks.length; rci++) {
          var rc = rockChecks[rci];
          if (dist(worldX, worldY, rc[0], rc[1]) < rc[2] + rand() * 400) {
            isRock = true;
            elevation = 0.75;
          }
        }

        // Tropical forest near equatorial landmarks
        var forestChecks = [
          [ 8000, 18000, 2500],  // Deep forest
          [ 6000, 20000, 1800],  // Old tree
          [10000, 22000, 1500],  // Mushroom grove
          [ 5000, 21000, 2000],  // Ancient grove
          [12000, 19000, 1500],  // Forest clearing
          [14000, 17000, 1200],  // Forest edge
        ];
        for (var fci = 0; fci < forestChecks.length; fci++) {
          var fc = forestChecks[fci];
          if (dist(worldX, worldY, fc[0], fc[1]) < fc[2] + rand() * 600) {
            isForest = true;
            isTropical = true;
          }
        }

        // At biome edges, randomly inherit properties from the second biome
        // This creates organic, scattered transitions instead of hard lines
        if (blendFactor > 0.2 && rand() < blendFactor * 0.6) {
            // Swap to second biome's properties occasionally
            // Re-run the property assignment for secondBiome
            // (just override the boolean flags)
            var sb = secondBiome;
            if (sb.indexOf("ice") === 0) { isIce = true; isTundra = true; }
            else if (sb.indexOf("tundra") === 0) { isTundra = true; isForest = false; }
            else if (sb.indexOf("boreal") === 0) { isBoreal = true; }
            else if (sb === "highlands") { isRock = true; }
            else if (sb.indexOf("tropical") === 0) { isTropical = true; isForest = true; }
            else if (sb.indexOf("forest") === 0) { isForest = true; }
            else if (sb === "grassland" || sb === "meadow") { isMeadow = true; isForest = false; }
            else if (sb === "desert") { isDesert = true; isForest = false; isMeadow = false; }
            else if (sb === "savanna" || sb === "scrubland") { isSavanna = true; }
            else if (sb.indexOf("coast") === 0) { isCoast = true; }
        }

        // Store blend info for soft rendering
        terrainGrid[r][c] = {
          biome: closestBiome,
          secondBiome: secondBiome,
          blendFactor: blendFactor,
          elevation: elevation,
          latFactor: latFactor,
          isWater: isWater,
          isForest: isForest && !isWater,
          isRock: isRock && !isWater,
          isMeadow: isMeadow && !isWater && !isForest && !isRock,
          isWetland: isWetland && !isWater,
          isTundra: isTundra && !isWater,
          isIce: isIce && !isWater,
          isDesert: isDesert && !isWater,
          isCoast: isCoast && !isWater,
          isTropical: isTropical && !isWater,
          isSavanna: isSavanna && !isWater && !isDesert,
          isBoreal: isBoreal && !isWater,
          variation: rand()
        };
      }
    }
  }

  // Render terrain to offscreen pixel canvas (200x150, each pixel = 1 tile)
  function renderTerrainPixels(season, timeOfDay, weather, rainfall) {
    season = season || "summer";
    timeOfDay = timeOfDay || "midday";
    weather = weather || "clear";
    rainfall = rainfall || 0;

    if (!terrainGrid) generateTerrainMap();

    var offscreen = document.createElement("canvas");
    offscreen.width = ENV_COLS;
    offscreen.height = ENV_ROWS;
    var ctx = offscreen.getContext("2d");
    var imgData = ctx.createImageData(ENV_COLS, ENV_ROWS);
    var data = imgData.data;

    var temperature = 20; // default; will be overridden by climate data
    if (state && state.climate && state.climate.temperature_avg != null) {
      temperature = parseFloat(state.climate.temperature_avg);
    }

    // Time-of-day lighting multipliers
    var lightMul = { r: 1.0, g: 1.0, b: 1.0 };
    switch (timeOfDay) {
      case "dawn":       lightMul = { r: 1.1, g: 0.95, b: 0.85 }; break;
      case "morning":    lightMul = { r: 1.0, g: 1.0, b: 0.95 }; break;
      case "midday":     lightMul = { r: 1.0, g: 1.0, b: 1.0 }; break;
      case "afternoon":  lightMul = { r: 1.0, g: 0.98, b: 0.92 }; break;
      case "dusk":       lightMul = { r: 1.05, g: 0.85, b: 0.7 }; break;
      case "evening":    lightMul = { r: 0.7, g: 0.6, b: 0.65 }; break;
      case "night":      lightMul = { r: 0.4, g: 0.45, b: 0.6 }; break;
      case "deep_night": lightMul = { r: 0.25, g: 0.28, b: 0.45 }; break;
    }

    // Seeded variation PRNG (must be stable across frames)
    var seed = 77;
    function rand() { seed = (seed * 48271) % 2147483647; return (seed - 1) / 2147483646; }

    for (var r = 0; r < ENV_ROWS; r++) {
      for (var c = 0; c < ENV_COLS; c++) {
        var tile = terrainGrid[r][c];
        var v = tile.variation;
        var cr, cg, cb;

        // Latitude factor for color temperature gradient
        var lat = tile.latFactor || 0.5; // 0 = equator, 1 = poles

        if (tile.isWater) {
          // Water color varies with latitude — warm tropical blue vs cold polar blue
          var depthFactor = Math.max(0, Math.min(1, (0.4 - tile.elevation) * 3));
          if (lat > 0.85) {
            // Polar water — icy blue-white
            cr = Math.round(160 + v * 30);
            cg = Math.round(180 + v * 25);
            cb = Math.round(210 + v * 20);
          } else {
            cr = Math.round(22 + (1 - depthFactor) * 35);
            cg = Math.round(50 + (1 - depthFactor) * 40);
            cb = Math.round(110 + depthFactor * 30);
            // Warm tropical water near equator
            if (lat < 0.3) { cr += 8; cg += 12; cb -= 5; }
          }
          // Wave highlights
          var wave = Math.sin((r * 0.8 + c * 0.3 + v * 20) * 0.5) * 0.5 + 0.5;
          cr += Math.round(wave * 12);
          cg += Math.round(wave * 15);
          cb += Math.round(wave * 8);
          if (v > 0.65) { cr += 18; cg += 22; cb += 12; }
          // Frozen water at poles
          if (lat > 0.8) {
            var frostAmt = Math.min(1.0, (lat - 0.8) * 5);
            cr = Math.round(cr + (200 - cr) * frostAmt);
            cg = Math.round(cg + (215 - cg) * frostAmt);
            cb = Math.round(cb + (240 - cb) * frostAmt);
          }
          cr += Math.round((v - 0.5) * 15);
          cg += Math.round((v - 0.5) * 20);
          cb += Math.round((v - 0.5) * 20);

        } else if (tile.isIce) {
          // Ice caps — bright white with blue tinge
          cr = 220; cg = 228; cb = 240;
          if (v > 0.5) { cr = 210; cg = 218; cb = 235; }
          if (v > 0.8) { cr = 195; cg = 205; cb = 225; } // crevasse
          if (season === "winter") { cr += 10; cg += 10; cb += 8; }
          cr += Math.round((v - 0.5) * 10);
          cg += Math.round((v - 0.5) * 10);
          cb += Math.round((v - 0.5) * 8);

        } else if (tile.isTundra) {
          // Tundra — white/ice blue, sparse grey-green
          cr = 195; cg = 205; cb = 215;
          if (v > 0.5) { cr = 180; cg = 190; cb = 200; }
          if (v > 0.75) { cr = 165; cg = 175; cb = 180; } // exposed rock
          if (v > 0.9) { cr = 140; cg = 155; cb = 150; } // sparse lichen
          if (season === "winter") { cr = 225; cg = 230; cb = 240; }
          cr += Math.round((v - 0.5) * 12);
          cg += Math.round((v - 0.5) * 12);
          cb += Math.round((v - 0.5) * 10);

        } else if (tile.isBoreal) {
          // Boreal — grey-green sparse forest
          cr = 75; cg = 95; cb = 70;
          if (v > 0.6) { cr = 85; cg = 100; cb = 75; }
          if (v > 0.85) { cr = 110; cg = 115; cb = 100; } // snow patch
          if (season === "winter") { cr += 40; cg += 40; cb += 50; }
          if (season === "spring") { cg += 10; }
          cr += Math.round((v - 0.5) * 16);
          cg += Math.round((v - 0.5) * 16);
          cb += Math.round((v - 0.5) * 12);

        } else if (tile.isTropical && tile.isForest) {
          // Tropical forest — dense lush green
          cr = 15; cg = 75; cb = 20;
          var canopy = Math.sin(c * 1.7 + r * 2.3 + v * 30) * 0.5 + 0.5;
          cr -= Math.round(canopy * 10);
          cg -= Math.round(canopy * 8);
          cb -= Math.round(canopy * 5);
          if (v > 0.88) { cr += 15; cg += 20; cb += 5; } // canopy gap
          if (v > 0.95) { cr += 10; cg += 5; cb -= 3; } // flower
          cr += Math.round((v - 0.5) * 10);
          cg += Math.round((v - 0.5) * 14);
          cb += Math.round((v - 0.5) * 6);

        } else if (tile.isForest) {
          // Temperate/conifer forest — varies with latitude
          switch (season) {
            case "spring": cr = 30; cg = 85; cb = 35; break;
            case "summer": cr = 25; cg = 72; cb = 28; break;
            case "autumn": cr = 85; cg = 70; cb = 25; break;
            case "winter": cr = 50; cg = 65; cb = 48; break;
            default:       cr = 28; cg = 75; cb = 30;
          }
          // Latitude tint — greyer toward poles
          cr = Math.round(cr + lat * 25);
          cg = Math.round(cg - lat * 10);
          cb = Math.round(cb + lat * 15);
          var canopy = Math.sin(c * 1.7 + r * 2.3 + v * 30) * 0.5 + 0.5;
          cr -= Math.round(canopy * 15);
          cg -= Math.round(canopy * 10);
          cb -= Math.round(canopy * 6);
          if (v > 0.88) { cr += 18; cg += 22; cb += 8; }
          if (season === "autumn" && v > 0.7) { cr += 30; cg -= 10; cb -= 5; }
          cr += Math.round((v - 0.5) * 12);
          cg += Math.round((v - 0.5) * 14);
          cb += Math.round((v - 0.5) * 8);

        } else if (tile.isRock) {
          // Rock / mountain
          cr = 105; cg = 100; cb = 90;
          if (weather === "rain" || weather === "storm" || rainfall > 50) {
            cr = 80; cg = 75; cb = 70;
          }
          // Snow on high peaks near poles
          if (lat > 0.4) {
            var snowAmt = Math.min(1.0, (lat - 0.4) * 1.5);
            cr = Math.round(cr + (220 - cr) * snowAmt);
            cg = Math.round(cg + (225 - cg) * snowAmt);
            cb = Math.round(cb + (235 - cb) * snowAmt);
          }
          cr += Math.round((v - 0.5) * 30);
          cg += Math.round((v - 0.5) * 30);
          cb += Math.round((v - 0.5) * 30);

        } else if (tile.isSavanna) {
          // Savanna / scrubland — golden brown with scattered green
          cr = 180; cg = 160; cb = 95;
          if (v > 0.7) { cr = 165; cg = 148; cb = 85; }
          // Scattered green bushes
          if (v > 0.85) { cr = 100; cg = 120; cb = 60; }
          cr += Math.round((v - 0.5) * 18);
          cg += Math.round((v - 0.5) * 14);
          cb += Math.round((v - 0.5) * 10);

        } else if (tile.isDesert) {
          // Desert — warm tan/sand
          cr = 200; cg = 175; cb = 120;
          if (v > 0.7) { cr = 185; cg = 160; cb = 105; }
          if (v > 0.9) { cr = 170; cg = 150; cb = 100; }
          cr += 10;
          cr += Math.round((v - 0.5) * 18);
          cg += Math.round((v - 0.5) * 14);
          cb += Math.round((v - 0.5) * 10);

        } else if (tile.isMeadow) {
          // Meadow — color depends on latitude
          if (lat < 0.3) {
            // Tropical meadow — lush green
            switch (season) {
              case "spring": cr = 60; cg = 150; cb = 45; break;
              case "summer": cr = 50; cg = 140; cb = 40; break;
              case "autumn": cr = 80; cg = 135; cb = 50; break;
              case "winter": cr = 65; cg = 130; cb = 55; break;
              default:       cr = 55; cg = 145; cb = 42;
            }
          } else if (lat < 0.5) {
            // Temperate meadow
            switch (season) {
              case "spring": cr = 85; cg = 145; cb = 55; break;
              case "summer": cr = 75; cg = 135; cb = 50; break;
              case "autumn": cr = 145; cg = 125; cb = 55; break;
              case "winter": cr = 110; cg = 115; cb = 80; break;
              default:       cr = 80; cg = 140; cb = 52;
            }
          } else {
            // Cold meadow — brown-grey
            cr = 140; cg = 130; cb = 100;
            if (season === "winter") { cr = 170; cg = 170; cb = 165; }
          }
          if (season === "spring" && v > 0.88 && lat < 0.5) {
            if (v > 0.94) { cr = 220; cg = 120; cb = 150; }
            else { cr = 220; cg = 200; cb = 80; }
          }
          cr += Math.round((v - 0.5) * 20);
          cg += Math.round((v - 0.5) * 20);
          cb += Math.round((v - 0.5) * 14);

        } else if (tile.isWetland) {
          // Wetland — dark brown-green
          cr = 75; cg = 70; cb = 50;
          if (weather === "rain" || rainfall > 40) { cr = 60; cg = 58; cb = 45; }
          cr += Math.round((v - 0.5) * 16);
          cg += Math.round((v - 0.5) * 16);
          cb += Math.round((v - 0.5) * 16);

        } else if (tile.isCoast) {
          // Coast — sandy beach
          cr = 195; cg = 185; cb = 150;
          if (v > 0.6) { cr = 180; cg = 170; cb = 140; }
          if (v > 0.85) { cr = 160; cg = 155; cb = 130; }
          cr += Math.round((v - 0.5) * 15);
          cg += Math.round((v - 0.5) * 15);
          cb += Math.round((v - 0.5) * 12);

        } else {
          // Default grass — latitude-driven color gradient
          // Green at equator, brown/grey toward poles
          var greenness = Math.max(0, 1.0 - lat * 1.5); // 1 at equator, 0 at lat>0.67
          switch (season) {
            case "spring":
              cr = Math.round(85 + (1 - greenness) * 60);
              cg = Math.round(145 * greenness + 100 * (1 - greenness));
              cb = Math.round(55 + (1 - greenness) * 30);
              break;
            case "summer":
              cr = Math.round(75 + (1 - greenness) * 60);
              cg = Math.round(135 * greenness + 95 * (1 - greenness));
              cb = Math.round(50 + (1 - greenness) * 30);
              break;
            case "autumn":
              cr = Math.round(145 - greenness * 40);
              cg = Math.round(125 * greenness + 110 * (1 - greenness));
              cb = Math.round(55 + (1 - greenness) * 35);
              break;
            case "winter":
              cr = Math.round(85 + (1 - greenness) * 80);
              cg = Math.round(100 * greenness + 110 * (1 - greenness));
              cb = Math.round(65 + (1 - greenness) * 50);
              break;
            default:
              cr = Math.round(75 + (1 - greenness) * 60);
              cg = Math.round(135 * greenness + 95 * (1 - greenness));
              cb = Math.round(50 + (1 - greenness) * 30);
          }
          cr += Math.round((v - 0.5) * 24);
          cg += Math.round((v - 0.5) * 24);
          cb += Math.round((v - 0.5) * 18);
        }

        // Latitude color temperature gradient — blue tint at poles, warm tint at equator
        if (!tile.isWater) {
          if (lat > 0.6) {
            // Polar blue tint
            var polarBlend = Math.min(0.3, (lat - 0.6) * 0.75);
            cr = Math.round(cr * (1 - polarBlend) + 200 * polarBlend);
            cg = Math.round(cg * (1 - polarBlend) + 210 * polarBlend);
            cb = Math.round(cb * (1 - polarBlend * 0.5) + 230 * polarBlend * 0.5);
          } else if (lat < 0.2) {
            // Equatorial warm tint
            var warmBlend = Math.min(0.1, (0.2 - lat) * 0.5);
            cr = Math.round(cr * (1 + warmBlend));
            cg = Math.round(cg * (1 + warmBlend * 0.3));
            cb = Math.round(cb * (1 - warmBlend * 0.3));
          }
        }

        // Snow overlay for polar/high latitude terrain
        if (lat > 0.7 && !tile.isWater && !tile.isIce && !tile.isTundra) {
          var snowBlend = Math.min(0.6, (lat - 0.7) * 2.0);
          snowBlend *= (0.5 + tile.elevation * 0.5);
          if (season === "winter") snowBlend = Math.min(0.8, snowBlend * 1.4);
          cr = Math.round(cr + (230 - cr) * snowBlend);
          cg = Math.round(cg + (235 - cg) * snowBlend);
          cb = Math.round(cb + (245 - cb) * snowBlend);
        }

        // Apply time-of-day lighting
        cr = Math.round(cr * lightMul.r);
        cg = Math.round(cg * lightMul.g);
        cb = Math.round(cb * lightMul.b);

        // Weather effects
        if (weather === "rain") {
          cr = Math.round(cr * 0.95);
          cg = Math.round(cg * 0.95);
          cb = Math.round(cb * 1.05);
        } else if (weather === "fog" || weather === "mist") {
          var grey = Math.round((cr + cg + cb) / 3);
          cr = Math.round(cr + (grey - cr) * 0.3);
          cg = Math.round(cg + (grey - cg) * 0.3);
          cb = Math.round(cb + (grey - cb) * 0.3);
        } else if (weather === "storm") {
          cr = Math.round(cr * 0.7);
          cg = Math.round(cg * 0.7);
          cb = Math.round(cb * 0.7);
        }

        // Biome edge blending — soften transitions between biomes
        // At biome boundaries, blend toward the latitude-appropriate neutral color
        // This prevents hard geometric circles
        if (tile.blendFactor > 0.05) {
          var bf = tile.blendFactor;
          // Latitude-based neutral: warm brown at equator, grey at poles
          var lat = tile.latFactor || 0;
          var nr = Math.round(85 + (1 - lat) * 50);  // 85-135
          var ng = Math.round(80 + (1 - lat) * 45);   // 80-125
          var nb = Math.round(60 + (1 - lat) * 20);   // 60-80
          cr = Math.round(cr * (1 - bf * 0.4) + nr * (bf * 0.4));
          cg = Math.round(cg * (1 - bf * 0.4) + ng * (bf * 0.4));
          cb = Math.round(cb * (1 - bf * 0.4) + nb * (bf * 0.4));
        }

        // Latitude color temperature — warm at equator, cool at poles
        // This creates a smooth global gradient that ties the whole map together
        var lat = tile.latFactor || 0;
        // Warm shift at equator (add red/yellow), cool shift at poles (add blue)
        var warmth = (1 - lat) * 0.12;  // 0 at poles, 0.12 at equator
        var coolness = lat * 0.08;       // 0 at equator, 0.08 at poles
        cr = Math.round(cr * (1 + warmth) * (1 - coolness * 0.5));
        cg = Math.round(cg * (1 + warmth * 0.3) * (1 - coolness * 0.3));
        cb = Math.round(cb * (1 - warmth * 0.3) * (1 + coolness));

        // Clamp
        cr = Math.max(0, Math.min(255, cr));
        cg = Math.max(0, Math.min(255, cg));
        cb = Math.max(0, Math.min(255, cb));

        var idx = (r * ENV_COLS + c) * 4;
        data[idx]     = cr;
        data[idx + 1] = cg;
        data[idx + 2] = cb;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    terrainCanvas = offscreen;

    // Also build minimap
    buildMinimap();
  }

  function buildMinimap() {
    // 80x60 minimap — scaled down from 200x150 terrain
    minimapCanvas = document.createElement("canvas");
    minimapCanvas.width = 80;
    minimapCanvas.height = 60;
    var mctx = minimapCanvas.getContext("2d");
    mctx.imageSmoothingEnabled = false;
    if (terrainCanvas) {
      mctx.drawImage(terrainCanvas, 0, 0, 80, 60);
    }
  }

  // Citizen palette for per-citizen charts (10 distinct colors)
  var PALETTE = [
    "#5a9bba", "#d4a574", "#4a9e6e", "#c44a20", "#8a6abf",
    "#c4648c", "#d4c474", "#6a8a5a", "#9a6a4a", "#7a8ab0"
  ];

  var STAGE_MAP = {
    "pre-language":      "stage-pre-language",
    "first words":       "stage-first-words",
    "first-words":       "stage-first-words",
    "basic vocabulary":  "stage-basic-vocabulary",
    "basic-vocabulary":  "stage-basic-vocabulary",
    "proto-grammar":     "stage-proto-grammar",
    "proto grammar":     "stage-proto-grammar",
    "culture":           "stage-culture",
    "civilization":      "stage-civilization"
  };

  // ---------------------------------------------------------------------------
  // Application State
  // ---------------------------------------------------------------------------

  var state = null;
  var citizenPositions = {};   // smoothed positions for map
  var history = {
    vocab_size: [],
    success_rate: [],
    citizen_vocab: {}          // per-citizen vocab over time
  };
  var seenInteractionIds = new Set();
  var seenEventIds = new Set();
  var feedPaused = false;
  var lastAnimTime = 0;
  var activeTab = "overview";
  var activeEventFilter = "all";
  var dictSortKey = "confidence";
  var dictSearchTerm = "";

  // Force-directed graph state
  var forceNodes = [];
  var forceInitialized = false;

  // ---------------------------------------------------------------------------
  // Audio Player for Proto-Language Clips
  // ---------------------------------------------------------------------------

  var audioPlayer = null;
  var activePlayBtn = null;

  function playProtoSound(sound, btn) {
    // Stop any currently playing audio
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; }
    if (activePlayBtn) { activePlayBtn.classList.remove("playing"); activePlayBtn = null; }

    var audioUrl = "/api/audio?sound=" + encodeURIComponent(sound);
    if (API_KEY) audioUrl += "&key=" + encodeURIComponent(API_KEY);
    audioPlayer = new Audio(audioUrl);
    if (btn) {
      btn.classList.add("playing");
      activePlayBtn = btn;
    }
    audioPlayer.addEventListener("ended", function () {
      if (activePlayBtn) activePlayBtn.classList.remove("playing");
      activePlayBtn = null;
      audioPlayer = null;
    });
    audioPlayer.addEventListener("error", function () {
      if (activePlayBtn) activePlayBtn.classList.remove("playing");
      activePlayBtn = null;
      audioPlayer = null;
    });
    audioPlayer.play().catch(function () {
      if (activePlayBtn) activePlayBtn.classList.remove("playing");
      activePlayBtn = null;
      audioPlayer = null;
    });
  }

  // Check if a given sound has a voice clip available
  function hasVoiceClip(sound) {
    if (!state || !state.voice_clips) return false;
    for (var i = 0; i < state.voice_clips.length; i++) {
      if (state.voice_clips[i].sound === sound) return true;
    }
    return false;
  }

  // Create a small play button element
  function createPlayBtn(sound) {
    var btn = createEl("button", "play-btn");
    btn.textContent = "\u25B6";
    btn.title = "Play \"" + sound + "\"";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      playProtoSound(sound, btn);
    });
    return btn;
  }

  // ---------------------------------------------------------------------------
  // DOM Helpers
  // ---------------------------------------------------------------------------

  function byId(id) { return document.getElementById(id); }

  function setText(el, text) {
    if (typeof el === "string") el = byId(el);
    if (!el) return;
    var newText = String(text != null ? text : "");
    var oldText = el.textContent;
    el.textContent = newText;
    // Flash when value changes — makes the dashboard feel alive
    if (oldText !== newText && oldText !== "" && oldText !== "--") {
      el.classList.remove("changed", "tick-pulse");
      // Force reflow to restart animation
      void el.offsetWidth;
      if (el.classList.contains("dash-big")) {
        el.classList.add("changed");
      } else if (el.id === "tick-value") {
        el.classList.add("tick-pulse");
      }
    }
  }

  function createEl(tag, className, textContent) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent != null) el.textContent = String(textContent);
    return el;
  }

  function createSpan(className, text) {
    return createEl("span", className, text);
  }

  function clearEl(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init() {
    log(LOG_LEVEL.INFO, "init", "A New World Dashboard initializing...");
    var t0 = performance.now();

    var steps = [
      ["initTabs", initTabs],
      ["initTooltips", initTooltips],
      ["initFeedPause", initFeedPause],
      ["initDictControls", initDictControls],
      ["initEventFilters", initEventFilters],
      ["initMapControls", initMapControls],
    ];

    steps.forEach(function (step) {
      safe("init/" + step[0], step[1]);
    });

    // Read hash for initial tab
    var hash = window.location.hash.replace("#", "");
    if (hash && ["overview", "citizens", "language", "events", "learning"].indexOf(hash) !== -1) {
      switchTab(hash);
    }

    window.addEventListener("hashchange", function () {
      var h = window.location.hash.replace("#", "");
      if (h && h !== activeTab) switchTab(h);
    });

    window.addEventListener("resize", function () {
      safe("resize", resizeCanvases);
    });

    // Global error handler for uncaught errors
    window.addEventListener("error", function (e) {
      log(LOG_LEVEL.ERROR, "global", e.message, { filename: e.filename, lineno: e.lineno, colno: e.colno });
      trackError("uncaught");
    });

    window.addEventListener("unhandledrejection", function (e) {
      log(LOG_LEVEL.ERROR, "global", "Unhandled promise rejection: " + (e.reason && e.reason.message || e.reason));
      trackError("unhandled_promise");
    });

    // Start polling and animation
    poll();
    setInterval(poll, POLL_INTERVAL);
    requestAnimationFrame(animate);

    // Initial canvas sizing (needs a brief delay for layout)
    setTimeout(function () { safe("resize", resizeCanvases); }, 100);

    var elapsed = (performance.now() - t0).toFixed(1);
    log(LOG_LEVEL.INFO, "init", "Dashboard ready in " + elapsed + "ms");

    // Expose diagnostics on window for console access
    window.WM_DIAG = {
      getState: function () { return state; },
      getHistory: function () { return history; },
      getErrors: function () { return errorCounts; },
      getPollStats: function () { return { pollCount: pollCount, lastPollMs: lastPollMs }; },
      setLogLevel: function (lvl) { currentLogLevel = lvl; log(LOG_LEVEL.INFO, "diag", "Log level set to " + lvl); },
      LOG_LEVEL: LOG_LEVEL,
    };
    log(LOG_LEVEL.INFO, "init", "Diagnostics available: window.WM_DIAG");
  }

  // ---------------------------------------------------------------------------
  // Tab System
  // ---------------------------------------------------------------------------

  function initTabs() {
    var tabBtns = document.querySelectorAll(".tab-btn");
    tabBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchTab(btn.dataset.tab);
      });
    });

    // Mobile dropdown
    var toggle = byId("tab-dropdown-toggle");
    var menu = byId("tab-dropdown-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.classList.toggle("open");
      });
      menu.querySelectorAll("button").forEach(function (btn) {
        btn.addEventListener("click", function () {
          switchTab(btn.dataset.tab);
          menu.classList.remove("open");
        });
      });
      document.addEventListener("click", function () {
        menu.classList.remove("open");
      });
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    window.location.hash = tab;

    // Update tab buttons
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });

    // Update tab panes
    document.querySelectorAll(".tab-pane").forEach(function (p) {
      p.classList.toggle("active", p.id === "tab-" + tab);
    });

    // Update mobile dropdown text
    var toggle = byId("tab-dropdown-toggle");
    if (toggle) {
      var names = { overview: "Overview", citizens: "Citizens", language: "Language", events: "Events", learning: "Learning", "proto-sounds": "Proto-Sounds" };
      toggle.textContent = names[tab] || tab;
    }

    // Resize canvases when tab changes (some may have been hidden)
    setTimeout(resizeCanvases, 50);

    // Re-render tab content
    if (state) renderActiveTab();
  }

  // ---------------------------------------------------------------------------
  // Tooltip System
  // ---------------------------------------------------------------------------

  function initTooltips() {
    var tooltip = byId("tooltip");
    document.addEventListener("mouseover", function (e) {
      var target = e.target.closest("[data-tooltip]");
      if (target && tooltip) {
        tooltip.textContent = target.dataset.tooltip;
        tooltip.classList.add("visible");
        positionTooltip(tooltip, target);
      }
    });
    document.addEventListener("mouseout", function (e) {
      var target = e.target.closest("[data-tooltip]");
      if (target && tooltip) {
        tooltip.classList.remove("visible");
      }
    });
  }

  function positionTooltip(tooltip, target) {
    var rect = target.getBoundingClientRect();
    var tx = rect.left + rect.width / 2;
    var ty = rect.bottom + 8;

    // Keep within viewport
    tooltip.style.left = Math.max(10, Math.min(tx - 150, window.innerWidth - 340)) + "px";
    tooltip.style.top = ty + "px";
  }

  // ---------------------------------------------------------------------------
  // Feed Pause on Hover
  // ---------------------------------------------------------------------------

  function initFeedPause() {
    var feed = byId("live-feed");
    var pauseBar = byId("feed-pause-bar");
    if (!feed) return;

    feed.addEventListener("mouseenter", function () {
      feedPaused = true;
      feed.classList.add("paused");
      if (pauseBar) pauseBar.classList.add("visible");
    });
    feed.addEventListener("mouseleave", function () {
      feedPaused = false;
      feed.classList.remove("paused");
      if (pauseBar) pauseBar.classList.remove("visible");
    });
  }

  // ---------------------------------------------------------------------------
  // Dictionary Controls
  // ---------------------------------------------------------------------------

  function initDictControls() {
    var searchInput = byId("dict-search");
    var sortSelect = byId("dict-sort");

    if (searchInput) {
      searchInput.addEventListener("input", function () {
        dictSearchTerm = searchInput.value.toLowerCase();
        if (state) renderSharedDictionary();
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        dictSortKey = sortSelect.value;
        if (state) renderSharedDictionary();
      });
    }

    // Column header sorting
    var table = byId("shared-dict-table");
    if (table) {
      table.querySelectorAll("th.sortable").forEach(function (th) {
        th.addEventListener("click", function () {
          dictSortKey = th.dataset.sort;
          if (sortSelect) sortSelect.value = dictSortKey;
          if (state) renderSharedDictionary();
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Event Filters
  // ---------------------------------------------------------------------------

  function initEventFilters() {
    document.querySelectorAll(".filter-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeEventFilter = btn.dataset.filter;
        if (state) renderEventsTimeline();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Canvas Resizing
  // ---------------------------------------------------------------------------

  function resizeCanvases() {
    resizeCanvas("map-canvas");
    resizeCanvas("rel-canvas");
    resizeCanvas("sparkline-vocab");
    resizeCanvas("sparkline-success");
    resizeCanvas("chart-success-rate");
    resizeCanvas("chart-vocab-growth");
    resizeCanvas("chart-citizen-vocab");
  }

  function resizeCanvas(id) {
    var canvas = byId(id);
    if (!canvas) return;
    var parent = canvas.parentElement;
    if (!parent) return;
    var rect = parent.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    var dpr = window.devicePixelRatio || 1;

    // For fixed-height canvases, use explicit height attr or parent height
    var h = canvas.hasAttribute("height") && canvas.parentElement.classList.contains("map-container") === false
      ? parseInt(canvas.getAttribute("height"), 10) || rect.height
      : rect.height;

    canvas.width = rect.width * dpr;
    canvas.height = h * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = h + "px";
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async function poll() {
    var t0 = performance.now();
    pollCount++;
    try {
      var res = await apiFetch("/api/state");
      if (!res.ok) {
        var body = "";
        try { body = await res.text(); } catch (_) {}
        throw new Error("HTTP " + res.status + " " + res.statusText + (body ? " — " + body.substring(0, 200) : ""));
      }
      var raw = await res.text();
      var data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        throw new Error("JSON parse failed: " + parseErr.message + " — raw[0:200]: " + raw.substring(0, 200));
      }
      if (data.error) {
        throw new Error("API error: " + (data.message || data.error));
      }

      lastPollMs = performance.now() - t0;

      // Data shape validation
      validatePollData(data);

      state = data;
      setConnected(true);
      hideError();

      // On first successful poll, auto-center map on the tribe
      if (pollCount === 1) {
        var _canvas = byId("map-canvas");
        if (_canvas) {
          var _dpr = window.devicePixelRatio || 1;
          var _cssW = _canvas.width / _dpr;
          var _cssH = _canvas.height / _dpr;
          var _baseScale = Math.max(_cssW / ENV_COLS, _cssH / ENV_ROWS);
          // Center on fire_pit (25000, 20000) at zoom 2 — citizens spawn ±3000 units
          // away so zoom 4 clips outliers; zoom 2 keeps all of them on screen
          var _zoom = 2;
          var _sx = (25000 / TILE_PX) * _baseScale * _zoom;
          var _sy = (20000 / TILE_PX) * _baseScale * _zoom;
          mapZoom = _zoom;
          mapPanX = _cssW / 2 - _sx;
          mapPanY = _cssH / 2 - _sy;
        }
      }

      safe("update", update);

      // Log every 10th poll at INFO level, every poll at DEBUG
      if (pollCount % 10 === 0) {
        var citizens = (data.citizens_db || []).length;
        var liveCitizens = ((data.live_state || {}).citizens || []).length;
        var lexEntries = data.total_lexicon_entries || 0;
        var shared = (data.shared_lexicon || []).length;
        log(LOG_LEVEL.INFO, "poll", "Poll #" + pollCount + " OK in " + lastPollMs.toFixed(0) + "ms | citizens(db:" + citizens + " live:" + liveCitizens + ") lex:" + lexEntries + " shared:" + shared);
      } else {
        log(LOG_LEVEL.DEBUG, "poll", "Poll #" + pollCount + " OK in " + lastPollMs.toFixed(0) + "ms");
      }

    } catch (err) {
      lastPollMs = performance.now() - t0;
      trackError("poll");
      log(LOG_LEVEL.ERROR, "poll", "Poll #" + pollCount + " failed after " + lastPollMs.toFixed(0) + "ms: " + err.message);
      setConnected(false);
      showError("Connection lost: " + err.message);
    }
  }

  function validatePollData(data) {
    // Server-side query errors
    if (data.query_errors && data.query_errors.length > 0) {
      data.query_errors.forEach(function (qe) {
        log(LOG_LEVEL.WARN, "validate/server", "Server query '" + qe.query + "' failed: " + qe.error);
      });
    }
    if (data.query_time_ms) {
      log(LOG_LEVEL.DEBUG, "validate", "Server query time: " + data.query_time_ms + "ms");
    }

    // Core required fields
    if (!data.live_state && !data.citizens_db) {
      log(LOG_LEVEL.WARN, "validate", "Response has neither live_state nor citizens_db");
    }
    if (data.live_state) {
      validateShape("validate/live_state", data.live_state, ["tick", "day", "season", "citizens"]);
      var ls = data.live_state;
      if (ls.citizens && !Array.isArray(ls.citizens)) {
        log(LOG_LEVEL.WARN, "validate", "live_state.citizens is not an array: " + typeof ls.citizens);
      }
    }
    if (data.citizens_db && !Array.isArray(data.citizens_db)) {
      log(LOG_LEVEL.WARN, "validate", "citizens_db is not an array");
    }
    // Optional but expected
    if (!data.shared_lexicon) log(LOG_LEVEL.DEBUG, "validate", "No shared_lexicon in response");
    if (!data.lexicon_by_citizen) log(LOG_LEVEL.DEBUG, "validate", "No lexicon_by_citizen in response");
    if (!data.utterance_stats) log(LOG_LEVEL.DEBUG, "validate", "No utterance_stats in response");
    if (!data.science) log(LOG_LEVEL.DEBUG, "validate", "No science metrics in response");
    if (data.snapshots) log(LOG_LEVEL.DEBUG, "validate", "Snapshots: " + data.snapshots.length + " records");
    if (data.science_history) log(LOG_LEVEL.DEBUG, "validate", "Science history: " + data.science_history.length + " records");
    if (data.training_runs) log(LOG_LEVEL.DEBUG, "validate", "Training runs: " + data.training_runs.length + " records");

    // Science sub-fields
    if (data.science) {
      var sciKeys = ["zipf", "heaps", "network", "influence", "cascades", "growth_curve", "efficiency"];
      sciKeys.forEach(function (k) {
        if (!data.science[k]) {
          log(LOG_LEVEL.DEBUG, "validate/science", "Missing science." + k);
        } else if (data.science[k].error) {
          log(LOG_LEVEL.WARN, "validate/science", "science." + k + " has error: " + data.science[k].error);
        }
      });
    }
  }

  function setConnected(ok) {
    var dot = byId("status-dot");
    var label = byId("connection-label");
    if (dot) dot.classList.toggle("connected", ok);

    if (!ok) {
      showEvolvingOverlay(false);
      if (dot) dot.classList.remove("evolving");
      setText(label, "Disconnected");
      return;
    }

    var ls = state && state.live_state;

    // Show evolving overlay only when the simulation explicitly flags world_ended.
    // Ticks take 400-600 seconds due to LLM inference — a frozen tick number
    // is normal and must NOT trigger the overlay.
    if (ls && ls.world_ended) {
      if (dot) { dot.classList.remove("connected"); dot.classList.add("evolving"); }
      setText(label, "Evolving...");
      showEvolvingOverlay(true);
      return;
    }

    // If the publisher's timestamp hasn't updated in >3 minutes, the sim is offline.
    // The publisher writes every 5s when running, so 3 min = clearly dead.
    var staleMs = ls && ls.timestamp ? (Date.now() - ls.timestamp * 1000) : 0;
    if (staleMs > 180000) {
      if (dot) { dot.classList.remove("connected"); dot.classList.remove("evolving"); }
      setText(label, "Sim offline");
      showEvolvingOverlay(false);
      return;
    }

    showEvolvingOverlay(false);
    if (dot) dot.classList.remove("evolving");
    setText(label, "Live");
  }

  function showEvolvingOverlay(show) {
    var overlay = byId("evolving-overlay");
    if (!overlay) {
      // Create overlay on first use
      overlay = document.createElement("div");
      overlay.id = "evolving-overlay";
      overlay.className = "evolving-overlay";
      var inner = document.createElement("div");
      inner.className = "evolving-inner";

      var title = document.createElement("div");
      title.className = "evolving-title";
      title.textContent = "World is evolving";
      inner.appendChild(title);

      var desc = document.createElement("div");
      desc.className = "evolving-desc";
      desc.textContent = "The forge is between worlds. Training data from the last world is being harvested and base models are being retrained. This takes 15-45 minutes.";
      inner.appendChild(desc);

      var bar = document.createElement("div");
      bar.className = "evolving-bar";
      var fill = document.createElement("div");
      fill.className = "evolving-bar-fill";
      bar.appendChild(fill);
      inner.appendChild(bar);

      var status = document.createElement("div");
      status.className = "evolving-status";
      status.id = "evolving-status-text";
      status.textContent = "Retraining archetype models...";
      inner.appendChild(status);

      var note = document.createElement("div");
      note.className = "evolving-note";
      note.textContent = "The page will update automatically when the new world starts. You can leave and come back.";
      inner.appendChild(note);

      overlay.appendChild(inner);
      document.body.appendChild(overlay);
    }
    overlay.style.display = show ? "flex" : "none";
  }

  function showError(msg) {
    var banner = byId("error-banner");
    setText(banner, msg);
    if (banner) banner.classList.add("visible");
  }

  function hideError() {
    var banner = byId("error-banner");
    if (banner) banner.classList.remove("visible");
  }

  // ---------------------------------------------------------------------------
  // Main Update
  // ---------------------------------------------------------------------------

  function update() {
    if (!state) return;
    safe("update/topBar", updateTopBar);
    safe("update/history", updateHistory);
    safe("update/ecosystem", updateEcosystem);
    safe("update/dashCards", updateDashCards);
    safe("update/dashCharts", updateDashCharts);
    safe("update/activeTab", renderActiveTab);
  }

  function renderActiveTab() {
    switch (activeTab) {
      case "overview":
        safe("tab/overview/targets", updateCitizenTargets);
        safe("tab/overview/metrics", updateOverviewMetrics);
        safe("tab/overview/feed", updateLiveFeed);
        safe("tab/overview/sparklines", drawSparklines);
        break;
      case "citizens":
        safe("tab/citizens", renderCitizensTab);
        break;
      case "language":
        safe("tab/language", renderLanguageTab);
        break;
      case "events":
        safe("tab/events", renderEventsTimeline);
        break;
      case "learning":
        safe("tab/learning", renderLearningTab);
        break;
      case "proto-sounds":
        safe("tab/proto-sounds", renderProtoSoundsTab);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Top Bar
  // ---------------------------------------------------------------------------

  function updateTopBar() {
    var ls = state.live_state;
    if (!ls) return;

    setText("tick-value", ls.tick != null ? ls.tick : "--");
    setText("day-value", ls.day != null ? ls.day : "--");
    setText("season-value", ls.season || "--");
    setText("time-value", ls.time_of_day || "--");
    setText("weather-value", ls.weather || "--");

    var civ = ls.civilization || {};
    var stageName = civ.stage || "pre-language";
    var cls = STAGE_MAP[stageName] || "stage-pre-language";
    var stageEl = byId("stage-indicator");
    if (stageEl) {
      stageEl.className = "stage-indicator " + cls;
      stageEl.textContent = stageName.replace(/[-_]/g, " ");
    }

    // World badge
    var worlds = state.worlds || [];
    var activeWorld = worlds.find(function(w) { return w.status === "active"; });
    var worldBadge = byId("world-badge");
    if (worldBadge && activeWorld) {
      worldBadge.textContent = "World " + activeWorld.world_id;
    }
  }

  // ---------------------------------------------------------------------------
  // Citizen Helpers
  // ---------------------------------------------------------------------------

  function getCitizens() {
    if (!state) return [];
    var ls = state.live_state || {};
    var lsCitizens = Array.isArray(ls.citizens) ? ls.citizens : [];
    var dbCitizens = Array.isArray(state.citizens_db) ? state.citizens_db : [];
    if (lsCitizens.length === 0 && dbCitizens.length === 0) {
      log(LOG_LEVEL.DEBUG, "getCitizens", "No citizens from either source");
      return [];
    }

    var merged = {};
    dbCitizens.forEach(function (c) { merged[c.id] = Object.assign({}, c); });
    lsCitizens.forEach(function (c) {
      var loc = c.location || {};
      if (merged[c.id]) {
        var updates = {
          name: c.name || merged[c.id].name,  // use live_state name (anonymous)
          x: loc.x != null ? loc.x : merged[c.id].x,
          y: loc.y != null ? loc.y : merged[c.id].y,
          mood: c.mood != null ? c.mood : merged[c.id].mood,
          energy: c.energy != null ? c.energy : merged[c.id].energy,
          status: c.status || merged[c.id].status,
          speaking_to: c.speaking_to || null,
          current_speech: c.current_speech || "",
          top_relationships: c.top_relationships || []
        };
        if (c.hunger != null) updates.hunger = c.hunger;
        if (c.thirst != null) updates.thirst = c.thirst;
        if (c.health != null) updates.health = c.health;
        if (c.internal_name) updates.internal_name = c.internal_name;
        if (c.archetype) updates.archetype = c.archetype;
        Object.assign(merged[c.id], updates);
      } else {
        merged[c.id] = Object.assign({}, c, {
          x: loc.x != null ? loc.x : 25000,
          y: loc.y != null ? loc.y : 20000
        });
      }
    });
    return Object.values(merged).filter(function (c) { return c.active !== false && c.alive !== false; });
  }

  function findCitizenName(id) {
    if (!state) return id;
    var db = state.citizens_db || [];
    for (var i = 0; i < db.length; i++) {
      if (db[i].id === id) return db[i].name;
    }
    return id;
  }

  function getCitizenSex(id) {
    if (!state) return "male";
    var db = state.citizens_db || [];
    for (var i = 0; i < db.length; i++) {
      if (db[i].id === id) return db[i].sex || "male";
    }
    return "male";
  }

  function getCitizenColor(id) {
    if (!state) return PALETTE[0];
    var db = state.citizens_db || [];
    for (var i = 0; i < db.length; i++) {
      if (db[i].id === id) return PALETTE[i % PALETTE.length];
    }
    return PALETTE[0];
  }

  // ---------------------------------------------------------------------------
  // History Tracking
  // ---------------------------------------------------------------------------

  function updateHistory() {
    if (!state) return;
    var ls = state.live_state || {};
    var civ = ls.civilization || {};
    var ustats = state.utterance_stats || {};

    var vocabSize = state.shared_lexicon ? state.shared_lexicon.length : (civ.shared_vocabulary_size || 0);
    pushHistory(history.vocab_size, vocabSize);

    var totalU = ustats.total_utterances || 0;
    var successU = ustats.successful || 0;
    pushHistory(history.success_rate, totalU > 0 ? (successU / totalU) * 100 : 0);

    // Per-citizen vocab counts
    var citizens = getCitizens();
    citizens.forEach(function (c) {
      if (!history.citizen_vocab[c.id]) history.citizen_vocab[c.id] = [];
      var vl = (state.lexicon_by_citizen && state.lexicon_by_citizen[c.id]) ? state.lexicon_by_citizen[c.id].length : 0;
      pushHistory(history.citizen_vocab[c.id], vl);
    });
  }

  function pushHistory(arr, val) {
    arr.push(val);
    if (arr.length > HISTORY_SIZE) arr.shift();
  }

  // ---------------------------------------------------------------------------
  // Animation Loop (runs every frame for map + relationship web)
  // ---------------------------------------------------------------------------

  function animate(ts) {
    var dt = Math.min((ts - lastAnimTime) / 1000, 0.1);
    lastAnimTime = ts;

    // Smooth position interpolation
    var lerpSpeed = 3.0;
    for (var id in citizenPositions) {
      var p = citizenPositions[id];
      p.x += (p.targetX - p.x) * lerpSpeed * dt;
      p.y += (p.targetY - p.y) * lerpSpeed * dt;
    }

    if (activeTab === "overview") {
      drawMap();
      drawRelationshipWeb();
    }

    requestAnimationFrame(animate);
  }

  function updateCitizenTargets() {
    var citizens = getCitizens();
    citizens.forEach(function (c) {
      if (!citizenPositions[c.id]) {
        citizenPositions[c.id] = { x: c.x, y: c.y, targetX: c.x, targetY: c.y, prevX: c.x, prevY: c.y };
      } else {
        // Track previous position for movement trails
        citizenPositions[c.id].prevX = citizenPositions[c.id].x;
        citizenPositions[c.id].prevY = citizenPositions[c.id].y;
        citizenPositions[c.id].targetX = c.x;
        citizenPositions[c.id].targetY = c.y;
      }
    });
    setText("citizen-count", citizens.length + " citizens");
  }

  // ---------------------------------------------------------------------------
  // Map Rendering
  // ---------------------------------------------------------------------------

  function initMapControls() {
    var canvas = byId("map-canvas");
    if (!canvas) return;

    // Build terrain on first call
    if (!terrainCanvas) {
      generateTerrainMap();
      renderTerrainPixels("summer", "midday", "clear", 0);
    }

    // Zoom with scroll wheel (0.3x to 8x)
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var mouseX = e.clientX - rect.left;
      var mouseY = e.clientY - rect.top;
      var oldZoom = mapZoom;
      var delta = e.deltaY > 0 ? 0.9 : 1.1;
      // Minimum zoom = 1.0 (baseScale already uses Math.max to fill)
      mapZoom = Math.max(1.0, Math.min(50, mapZoom * delta));
      // Zoom toward mouse position
      mapPanX = mouseX - (mouseX - mapPanX) * (mapZoom / oldZoom);
      mapPanY = mouseY - (mouseY - mapPanY) * (mapZoom / oldZoom);
    }, { passive: false });

    // Pan with click and drag
    canvas.addEventListener("mousedown", function (e) {
      mapDragging = true;
      mapDragStartX = e.clientX;
      mapDragStartY = e.clientY;
      mapPanStartX = mapPanX;
      mapPanStartY = mapPanY;
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", function (e) {
      if (!mapDragging) return;
      mapPanX = mapPanStartX + (e.clientX - mapDragStartX);
      mapPanY = mapPanStartY + (e.clientY - mapDragStartY);
    });
    window.addEventListener("mouseup", function () {
      mapDragging = false;
      var c = byId("map-canvas");
      if (c) c.style.cursor = "grab";
    });

    canvas.style.cursor = "grab";

    // Mouse tracking for hover tooltips
    canvas.addEventListener("mousemove", function (e) {
      if (mapDragging) return; // don't tooltip while dragging
      var rect = canvas.getBoundingClientRect();
      mapMouseX = e.clientX - rect.left;
      mapMouseY = e.clientY - rect.top;
    });
    canvas.addEventListener("mouseleave", function () {
      mapMouseX = -1;
      mapMouseY = -1;
    });
  }

  // ---------------------------------------------------------------------------
  // Tooltip helpers for map hover
  // ---------------------------------------------------------------------------

  function screenToWorldX(sx, scale, panX) {
    return ((sx - panX) / scale) * TILE_PX;
  }

  function screenToWorldY(sy, scale, panY) {
    return ((sy - panY) / scale) * TILE_PX;
  }

  function drawTooltip(ctx, x, y, lines, cssW, cssH) {
    var lineHeight = 14;
    var padding = 8;
    var maxWidth = 0;
    ctx.font = "11px 'JetBrains Mono', monospace";
    lines.forEach(function (l) {
      var w = ctx.measureText(l).width;
      if (w > maxWidth) maxWidth = w;
    });
    var boxW = maxWidth + padding * 2;
    var boxH = lines.length * lineHeight + padding * 2;
    // Position tooltip to the right of cursor, flip if near edge
    var tx = x + 15;
    var ty = y - boxH / 2;
    if (tx + boxW > cssW) tx = x - boxW - 15;
    if (ty < 0) ty = 0;
    if (ty + boxH > cssH) ty = cssH - boxH;

    ctx.fillStyle = "rgba(10,10,18,0.92)";
    ctx.strokeStyle = "rgba(212,165,116,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundedRect(ctx, tx, ty, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "left";
    lines.forEach(function (line, i) {
      // First line bold/amber, rest light
      if (i === 0) ctx.fillStyle = "#d4a574";
      else ctx.fillStyle = "#e8dcc8";
      ctx.fillText(line, tx + padding, ty + padding + (i + 1) * lineHeight - 3);
    });
  }

  function drawMap() {
    var canvas = byId("map-canvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    if (w < 1 || h < 1) return;

    // Get current climate/environment state
    var ls = state ? (state.live_state || {}) : {};
    var climate = state ? (state.climate || {}) : {};
    var curSeason = ls.season || climate.season || "summer";
    var curTime = ls.time_of_day || "midday";
    var curWeather = ls.weather || "clear";
    var curRainfall = climate.rainfall || 0;

    // Regenerate terrain cache if season/weather/time changed
    if (!terrainCanvas ||
        terrainCacheSeason !== curSeason ||
        terrainCacheTime !== curTime ||
        terrainCacheWeather !== curWeather) {
      renderTerrainPixels(curSeason, curTime, curWeather, curRainfall);
      terrainCacheSeason = curSeason;
      terrainCacheTime = curTime;
      terrainCacheWeather = curWeather;
    }

    // Account for device pixel ratio
    var dpr = window.devicePixelRatio || 1;
    var cssW = w / dpr;
    var cssH = h / dpr;

    // Clear to dark background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0d0d14";
    ctx.fillRect(0, 0, w, h);

    // Work in CSS pixel space (scale for DPR once)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Calculate scale: FILL canvas — terrain must cover every pixel, no black ever
    var scaleX = cssW / ENV_COLS;
    var scaleY = cssH / ENV_ROWS;
    var baseScale = Math.max(scaleX, scaleY); // FILL not fit
    var scale = baseScale * mapZoom;

    // Terrain dimensions at current zoom
    var terrainW = ENV_COLS * scale;
    var terrainH = ENV_ROWS * scale;

    // Clamp pan — terrain edge can never enter the viewport
    var minPanX = cssW - terrainW;  // left edge of terrain at right edge of canvas
    var maxPanX = 0;                 // right edge of terrain at left edge of canvas
    var minPanY = cssH - terrainH;
    var maxPanY = 0;
    mapPanX = Math.max(minPanX, Math.min(maxPanX, mapPanX));
    mapPanY = Math.max(minPanY, Math.min(maxPanY, mapPanY));

    ctx.save();
    ctx.translate(mapPanX, mapPanY);

    // Draw cached terrain with nearest-neighbor (pixel-art crisp edges)
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;

    // Scale the 200x150 terrain up to fill canvas area
    ctx.drawImage(terrainCanvas, 0, 0, ENV_COLS * scale, ENV_ROWS * scale);

    // Convert world coords to screen coords within the scaled terrain
    // World (0-4000, 0-3000) -> tile (0-200, 0-150) -> screen (tile * scale)
    var worldToScreenX = function (wx) { return (wx / TILE_PX) * scale; };
    var worldToScreenY = function (wy) { return (wy / TILE_PX) * scale; };

    // Landmark markers — subtle dots only, no names (citizens name places)
    if (mapLayers.labels) {
    for (var key in LANDMARKS) {
      var lm = LANDMARKS[key];
      var lx = worldToScreenX(lm.x);
      var ly = worldToScreenY(lm.y);
      if (lx + mapPanX > -100 && lx + mapPanX < cssW + 100 &&
          ly + mapPanY > -100 && ly + mapPanY < cssH + 100) {
        // Soft glow dot marking a place of interest
        ctx.fillStyle = "rgba(255,220,180,0.15)";
        ctx.beginPath();
        ctx.arc(lx, ly, Math.max(4, 8 * mapZoom), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,220,180,0.4)";
        ctx.beginPath();
        ctx.arc(lx, ly, Math.max(1.5, 3 * mapZoom), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    } // end labels toggle

    // Draw fauna indicators (togglable)
    if (mapLayers.animals && state && state.fauna) {
      var fauna = state.fauna;

      // Predator positions (red triangles)
      var predPositions = fauna.predator_positions;
      if (typeof predPositions === "string") { try { predPositions = JSON.parse(predPositions); } catch (_) { predPositions = null; } }
      if (Array.isArray(predPositions)) {
        predPositions.forEach(function (p) {
          if (p && p.x != null && p.y != null) {
            var px = worldToScreenX(p.x);
            var py = worldToScreenY(p.y);
            var sz = Math.max(3, 4 * mapZoom);
            ctx.fillStyle = "rgba(196,74,32,0.85)";
            ctx.beginPath();
            ctx.moveTo(px, py - sz);
            ctx.lineTo(px - sz * 0.7, py + sz * 0.5);
            ctx.lineTo(px + sz * 0.7, py + sz * 0.5);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "rgba(255,100,60,0.6)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        });
      }

      // Prey positions (small green dots)
      var preyPositions = fauna.prey_positions;
      if (typeof preyPositions === "string") { try { preyPositions = JSON.parse(preyPositions); } catch (_) { preyPositions = null; } }
      if (Array.isArray(preyPositions)) {
        preyPositions.forEach(function (p) {
          if (p && p.x != null && p.y != null) {
            var ppx = worldToScreenX(p.x);
            var ppy = worldToScreenY(p.y);
            ctx.fillStyle = "rgba(74,158,110,0.7)";
            ctx.beginPath();
            ctx.arc(ppx, ppy, Math.max(1.5, 2.5 * mapZoom), 0, Math.PI * 2);
            ctx.fill();
          }
        });
      }

      // Bird positions (tiny white dots)
      var birdPositions = fauna.bird_positions;
      if (typeof birdPositions === "string") { try { birdPositions = JSON.parse(birdPositions); } catch (_) { birdPositions = null; } }
      if (Array.isArray(birdPositions)) {
        birdPositions.forEach(function (p) {
          if (p && p.x != null && p.y != null) {
            var bpx = worldToScreenX(p.x);
            var bpy = worldToScreenY(p.y);
            ctx.fillStyle = "rgba(240,240,255,0.6)";
            ctx.beginPath();
            ctx.arc(bpx, bpy, Math.max(1, 1.5 * mapZoom), 0, Math.PI * 2);
            ctx.fill();
          }
        });
      }
    }

    // Resources view: draw food-zone overlay sampled from terrain grid
    if (mapView === "resources" && terrainGrid) {
      var step = 15; // sample every 15 tiles (~750 world units) for performance
      var dotR = Math.max(2, (step * scale / TILE_PX) * 0.55);
      for (var rr = 0; rr < ENV_ROWS; rr += step) {
        for (var rc = 0; rc < ENV_COLS; rc += step) {
          var tile = terrainGrid[rr][rc];
          if (!tile) continue;
          var tx = worldToScreenX(rc * TILE_PX + TILE_PX * step / 2);
          var ty = worldToScreenY(rr * TILE_PX + TILE_PX * step / 2);
          if (tx < -dotR * 2 || tx > cssW + dotR * 2 || ty < -dotR * 2 || ty > cssH + dotR * 2) continue;
          if (tile.isWater) {
            ctx.fillStyle = "rgba(80,160,220,0.25)";
          } else if (tile.isWetland) {
            ctx.fillStyle = "rgba(80,200,140,0.30)";
          } else if (tile.isForest) {
            ctx.fillStyle = "rgba(60,180,80,0.28)";
          } else if (tile.isMeadow || tile.isTropical) {
            ctx.fillStyle = "rgba(140,210,80,0.22)";
          } else {
            continue;
          }
          ctx.beginPath();
          ctx.arc(tx, ty, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Flora depletion indicator (top-left corner)
      if (state && state.flora && state.flora.total_food != null) {
        var totalFood = state.flora.total_food;
        var depletedCells = state.flora.depleted_cells || 0;
        ctx.fillStyle = "rgba(10,10,18,0.80)";
        roundedRect(ctx, 8, 8, 170, 44, 4);
        ctx.fill();
        ctx.fillStyle = "#6bbd6b";
        ctx.font = "bold 11px 'JetBrains Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillText("Food supply: " + Math.round(totalFood).toLocaleString(), 16, 24);
        ctx.fillStyle = depletedCells > 50 ? "#c44a20" : "#888";
        ctx.fillText("Depleted zones: " + depletedCells, 16, 42);
      }
    }

    var citizens = getCitizens();

    // Speech connection lines
    citizens.forEach(function (c) {
      if (c.speaking_to && citizenPositions[c.id] && citizenPositions[c.speaking_to]) {
        var from = citizenPositions[c.id];
        var to = citizenPositions[c.speaking_to];
        ctx.strokeStyle = "rgba(212,165,116,0.5)";
        ctx.lineWidth = Math.max(1, 2 * mapZoom);
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(worldToScreenX(from.x), worldToScreenY(from.y));
        ctx.lineTo(worldToScreenX(to.x), worldToScreenY(to.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // Movement trails — faint lines showing where citizens moved from
    if (mapZoom > 0.3) {
      ctx.lineWidth = 1;
      citizens.forEach(function (c) {
        var pos = citizenPositions[c.id];
        if (!pos || pos.prevX == null) return;
        var dx = pos.x - pos.prevX;
        var dy = pos.y - pos.prevY;
        if (dx * dx + dy * dy < 4) return;  // not moving
        var px1 = worldToScreenX(pos.prevX);
        var py1 = worldToScreenY(pos.prevY);
        var px2 = worldToScreenX(pos.x);
        var py2 = worldToScreenY(pos.y);
        var colors = CITIZEN_COLORS[c.sex] || CITIZEN_COLORS.male;
        ctx.strokeStyle = colors.glow;
        ctx.beginPath();
        ctx.moveTo(px1, py1);
        ctx.lineTo(px2, py2);
        ctx.stroke();
      });
    }

    // Citizen dots (glowing, with names and speech bubbles)
    // Dots are a fixed size in WORLD space — they shrink when zoomed out, grow when zoomed in
    // but capped so they don't become absurdly large at high zoom
    var dotRadius = Math.max(2, Math.min(8, 4 * scale / baseScale));
    var nameFontSize = Math.max(7, Math.min(12, 9 * scale / baseScale));

    // Build per-citizen word counts for language view
    var _langWordCounts = {};
    if (mapView === "language" && state) {
      var _sharedLex = state.shared_lexicon || [];
      var _lexByCit = state.lexicon_by_citizen || {};
      var _sharedMeanings = {};
      _sharedLex.forEach(function(w) { _sharedMeanings[w.sound] = true; });
      getCitizens().forEach(function(cit) {
        var cnt = 0;
        // Count established_by entries
        _sharedLex.forEach(function(w) {
          if (w.established_by && Array.isArray(w.established_by) && w.established_by.indexOf(cit.id) !== -1) cnt++;
        });
        // Also count personal lexicon entries matching shared meanings
        var personal = _lexByCit[cit.id] || [];
        personal.forEach(function(v) { if (_sharedMeanings[v.sound]) cnt++; });
        _langWordCounts[cit.id] = cnt;
      });
    }

    function _langColor(wordCount) {
      if (wordCount === 0) return { base: "#c44a20", glow: "rgba(196,74,32,0.4)" };
      if (wordCount <= 2)  return { base: "#d48a34", glow: "rgba(212,138,52,0.4)" };
      if (wordCount <= 5)  return { base: "#c4c44a", glow: "rgba(196,196,74,0.4)" };
      if (wordCount <= 10) return { base: "#4a9e6e", glow: "rgba(74,158,110,0.4)" };
      return { base: "#5a9bba", glow: "rgba(90,155,186,0.4)" };
    }

    citizens.forEach(function (c) {
      var pos = citizenPositions[c.id];
      if (!pos) return;
      var px = worldToScreenX(pos.x);
      var py = worldToScreenY(pos.y);
      var colors;
      if (mapView === "language") {
        colors = _langColor(_langWordCounts[c.id] || 0);
      } else {
        colors = CITIZEN_COLORS[c.sex] || CITIZEN_COLORS.male;
      }
      var energy = c.energy != null ? c.energy : 0.5;
      var radius = dotRadius + energy * Math.min(3, 2 * scale / baseScale);

      // Glow
      var grad = ctx.createRadialGradient(px, py, 0, px, py, radius * 3);
      grad.addColorStop(0, colors.glow);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(px - radius * 3, py - radius * 3, radius * 6, radius * 6);

      // Dot
      ctx.fillStyle = colors.base;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();

      // White outline for visibility on terrain
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Speaking ring — pulses when citizen is actively talking
      if (c.speaking_to) {
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);  // smooth pulse
        var pulseRadius = radius + 4 + pulse * 4;
        ctx.strokeStyle = "rgba(212,165,116," + (0.5 + pulse * 0.4).toFixed(2) + ")";
        ctx.lineWidth = 1.5 + pulse;
        ctx.beginPath();
        ctx.arc(px, py, pulseRadius, 0, Math.PI * 2);
        ctx.stroke();
        // Second ring for extra visibility
        ctx.strokeStyle = "rgba(212,165,116," + (0.2 + pulse * 0.15).toFixed(2) + ")";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, pulseRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Name label (scale-aware: hide at very low zoom)
      if (mapLayers.labels && mapZoom > 0.4) {
        ctx.fillStyle = "rgba(255,248,240,0.9)";
        ctx.font = "bold " + nameFontSize + "px 'Inter', sans-serif";
        ctx.textAlign = "center";
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 3;
        ctx.strokeText(c.name, px, py - radius - 4);
        ctx.fillText(c.name, px, py - radius - 4);
      }

      // Speech bubble (scale-aware: only show at medium+ zoom)
      if (mapLayers.speech && mapZoom > 0.6 && c.current_speech && c.speaking_to) {
        var speech = c.current_speech;
        if (speech.length > 30) speech = speech.substring(0, 27) + "...";
        var bFontSize = Math.max(7, Math.min(11, 9 * scale / baseScale));
        ctx.font = "bold " + bFontSize + "px 'JetBrains Mono', monospace";
        var tw = ctx.measureText(speech).width;
        var bx = px - tw / 2 - 6;
        var by = py + radius + 8;
        var bpad = 5;

        ctx.fillStyle = "rgba(12,12,20,0.9)";
        ctx.strokeStyle = "rgba(212,165,116,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        roundedRect(ctx, bx, by, tw + bpad * 2 + 2, bFontSize + bpad * 2, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#d4a574";
        ctx.textAlign = "left";
        ctx.fillText(speech, bx + bpad + 1, by + bFontSize + bpad - 1);
        ctx.textAlign = "center";
      }
    });

    ctx.restore();

    // --- HUD elements drawn in CSS pixel space ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Zoom indicator (top-right corner)
    ctx.fillStyle = "rgba(232,220,200,0.5)";
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(mapZoom * 100) + "%", cssW - 8, 16);
    if (mapZoom !== 1.0) {
      ctx.fillStyle = "rgba(232,220,200,0.3)";
      ctx.font = "9px 'Inter', sans-serif";
      ctx.fillText("scroll to zoom, drag to pan", cssW - 8, 28);
    }

    // Mini-map (bottom-right corner, 80x60, always visible)
    if (minimapCanvas) {
      var mmW = 80;
      var mmH = 60;
      var mmPad = 8;
      var mmX = cssW - mmW - mmPad;
      var mmY = cssH - mmH - mmPad;

      // Background border
      ctx.fillStyle = "rgba(10,10,18,0.7)";
      ctx.fillRect(mmX - 2, mmY - 2, mmW + 4, mmH + 4);
      ctx.strokeStyle = "rgba(232,220,200,0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(mmX - 2, mmY - 2, mmW + 4, mmH + 4);

      // Draw minimap terrain
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(minimapCanvas, mmX, mmY, mmW, mmH);

      // Viewport rectangle on minimap
      // The main view shows: pan offset maps to world position, visible area depends on scale
      var totalTerrainW = ENV_COLS * scale;
      var totalTerrainH = ENV_ROWS * scale;
      var vpLeft = -mapPanX / totalTerrainW;
      var vpTop = -mapPanY / totalTerrainH;
      var vpWidth = w / totalTerrainW;
      var vpHeight = h / totalTerrainH;

      ctx.strokeStyle = "rgba(255,240,200,0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        mmX + Math.max(0, vpLeft) * mmW,
        mmY + Math.max(0, vpTop) * mmH,
        Math.min(1, vpWidth) * mmW,
        Math.min(1, vpHeight) * mmH
      );

      // Re-enable smoothing for non-pixel-art drawing
      ctx.imageSmoothingEnabled = true;
    }

    // Resources view legend (bottom-left)
    if (mapView === "resources") {
      var _resLegend = [
        { label: "Water / Fish",    color: "rgba(80,160,220,0.7)" },
        { label: "Wetland / Reeds", color: "rgba(80,200,140,0.7)" },
        { label: "Forest / Berries",color: "rgba(60,180,80,0.7)"  },
        { label: "Meadow / Seeds",  color: "rgba(140,210,80,0.7)" },
        { label: "▲ Predator",      color: "rgba(196,74,32,0.9)"  },
        { label: "● Prey",          color: "rgba(74,158,110,0.9)" },
      ];
      var _rlX = 10, _rlY = cssH - (_resLegend.length * 18) - 22;
      ctx.fillStyle = "rgba(10,10,18,0.7)";
      ctx.fillRect(_rlX - 4, _rlY - 14, 130, _resLegend.length * 18 + 22);
      ctx.fillStyle = "rgba(232,220,200,0.7)";
      ctx.font = "bold 9px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText("RESOURCES", _rlX, _rlY);
      _resLegend.forEach(function(item, idx) {
        var ly = _rlY + 12 + idx * 18;
        ctx.fillStyle = item.color;
        ctx.fillRect(_rlX, ly - 8, 10, 10);
        ctx.fillStyle = "rgba(232,220,200,0.7)";
        ctx.font = "9px 'Inter', sans-serif";
        ctx.fillText(item.label, _rlX + 14, ly);
      });
    }

    // Language view legend (bottom-left)
    if (mapView === "language") {
      var _langLegend = [
        { label: "0 words",   color: "#c44a20" },
        { label: "1-2 words", color: "#d48a34" },
        { label: "3-5 words", color: "#c4c44a" },
        { label: "6-10 words",color: "#4a9e6e" },
        { label: "10+ words", color: "#5a9bba" },
      ];
      var _llX = 10, _llY = cssH - (_langLegend.length * 18) - 22;
      ctx.fillStyle = "rgba(10,10,18,0.7)";
      ctx.fillRect(_llX - 4, _llY - 14, 110, _langLegend.length * 18 + 22);
      ctx.fillStyle = "rgba(232,220,200,0.7)";
      ctx.font = "bold 9px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText("LANGUAGE", _llX, _llY);
      _langLegend.forEach(function(item, idx) {
        var ly = _llY + 12 + idx * 18;
        ctx.fillStyle = item.color;
        ctx.fillRect(_llX, ly - 8, 10, 10);
        ctx.fillStyle = "rgba(232,220,200,0.7)";
        ctx.font = "9px 'Inter', sans-serif";
        ctx.fillText(item.label, _llX + 14, ly);
      });
    }

    // --- Hover tooltip (drawn last, above everything, in CSS pixel space) ---
    if (mapMouseX >= 0 && mapMouseY >= 0) {
      var worldX = screenToWorldX(mapMouseX, scale, mapPanX);
      var worldY = screenToWorldY(mapMouseY, scale, mapPanY);

      // Check citizens first (closest wins)
      var hoveredCitizen = null;
      var minDist = 30; // pixel threshold
      citizens.forEach(function (c) {
        var pos = citizenPositions[c.id];
        if (!pos) return;
        var sx = worldToScreenX(pos.x) + mapPanX;
        var sy = worldToScreenY(pos.y) + mapPanY;
        var d = Math.sqrt((mapMouseX - sx) * (mapMouseX - sx) + (mapMouseY - sy) * (mapMouseY - sy));
        if (d < minDist) { minDist = d; hoveredCitizen = c; }
      });

      // Check animals (predators, prey, birds)
      var hoveredAnimal = null;
      if (!hoveredCitizen && state && state.fauna) {
        var animalThreshold = 20;
        var faunaData = state.fauna;

        // Predators
        var preds = faunaData.predator_positions;
        if (typeof preds === "string") { try { preds = JSON.parse(preds); } catch (_) { preds = null; } }
        if (Array.isArray(preds)) {
          preds.forEach(function (p) {
            if (!p || p.x == null || p.y == null) return;
            var sx = worldToScreenX(p.x) + mapPanX;
            var sy = worldToScreenY(p.y) + mapPanY;
            var d = Math.sqrt((mapMouseX - sx) * (mapMouseX - sx) + (mapMouseY - sy) * (mapMouseY - sy));
            if (d < animalThreshold) {
              animalThreshold = d;
              hoveredAnimal = { type: "predator", species: p.species || "Predator", count: p.count || 1, behavior: p.behavior || "roaming", threat: "HIGH", x: p.x, y: p.y };
            }
          });
        }

        // Prey
        var preys = faunaData.prey_positions;
        if (typeof preys === "string") { try { preys = JSON.parse(preys); } catch (_) { preys = null; } }
        if (Array.isArray(preys)) {
          preys.forEach(function (p) {
            if (!p || p.x == null || p.y == null) return;
            var sx = worldToScreenX(p.x) + mapPanX;
            var sy = worldToScreenY(p.y) + mapPanY;
            var d = Math.sqrt((mapMouseX - sx) * (mapMouseX - sx) + (mapMouseY - sy) * (mapMouseY - sy));
            if (d < animalThreshold) {
              animalThreshold = d;
              hoveredAnimal = { type: "prey", species: p.species || "Prey", count: p.count || 1, behavior: p.behavior || "grazing", threat: "LOW", x: p.x, y: p.y };
            }
          });
        }

        // Birds
        var birds = faunaData.bird_positions;
        if (typeof birds === "string") { try { birds = JSON.parse(birds); } catch (_) { birds = null; } }
        if (Array.isArray(birds)) {
          birds.forEach(function (p) {
            if (!p || p.x == null || p.y == null) return;
            var sx = worldToScreenX(p.x) + mapPanX;
            var sy = worldToScreenY(p.y) + mapPanY;
            var d = Math.sqrt((mapMouseX - sx) * (mapMouseX - sx) + (mapMouseY - sy) * (mapMouseY - sy));
            if (d < animalThreshold) {
              animalThreshold = d;
              hoveredAnimal = { type: "bird", species: p.species || "Bird", count: p.count || 1, behavior: p.behavior || "flying", threat: "NONE", x: p.x, y: p.y };
            }
          });
        }
      }

      var tooltipLines = [];

      if (hoveredCitizen) {
        var hc = hoveredCitizen;
        tooltipLines.push(hc.name + " (" + (hc.role || "citizen") + ")");
        tooltipLines.push("Age: " + (hc.age != null ? hc.age : "?") + " | " + (hc.sex || "?"));
        tooltipLines.push("Mood: " + (hc.mood >= 0 ? "+" : "") + (hc.mood != null ? parseFloat(hc.mood).toFixed(2) : "0.00") + " | Energy: " + (hc.energy != null ? (parseFloat(hc.energy) * 100).toFixed(0) : "?") + "%");
        if (hc.hunger != null) tooltipLines.push("Hunger: " + parseFloat(hc.hunger).toFixed(2) + (hc.thirst != null ? " | Thirst: " + parseFloat(hc.thirst).toFixed(2) : ""));
        if (hc.status) tooltipLines.push("Status: " + hc.status);
        if (hc.current_speech) tooltipLines.push("\u201C" + hc.current_speech + "\u201D");
        // Vocab size
        var vocab = (state && state.lexicon_by_citizen && state.lexicon_by_citizen[hc.id]) ? state.lexicon_by_citizen[hc.id] : [];
        if (vocab.length > 0) tooltipLines.push("Vocab: " + vocab.length + " sounds");
      } else if (hoveredAnimal) {
        var ha = hoveredAnimal;
        var animalLabel = ha.species;
        if (ha.count > 1) animalLabel += " (" + ha.count + ")";
        tooltipLines.push(animalLabel);
        tooltipLines.push("Type: " + ha.type);
        tooltipLines.push("Behavior: " + ha.behavior);
        tooltipLines.push("Threat: " + ha.threat);
      } else {
        // Terrain tooltip — content varies by mapView mode
        var tileC = Math.floor(worldX / TILE_PX);
        var tileR = Math.floor(worldY / TILE_PX);
        if (terrainGrid && tileR >= 0 && tileR < ENV_ROWS && tileC >= 0 && tileC < ENV_COLS) {
          var tile = terrainGrid[tileR][tileC];
          var biome = (tile.biome || "unknown").replace(/_/g, " ");
          var terrainType = tile.isWater ? "water" : tile.isForest ? "forest" : tile.isRock ? "rock" : tile.isMeadow ? "meadow" : tile.isWetland ? "wetland" : tile.isTundra ? "tundra" : tile.isDesert ? "desert" : tile.isCoast ? "coast" : "grassland";

          if (mapView === "terrain") {
            tooltipLines.push(biome);
            tooltipLines.push("Terrain: " + terrainType);
            tooltipLines.push("Elevation: " + (tile.elevation || 0).toFixed(2));
            // Temperature estimate
            var climateData = state ? (state.climate || {}) : {};
            if (climateData.temperature_avg != null) {
              var baseTemp = parseFloat(climateData.temperature_avg);
              var adjTemp = baseTemp - (tile.elevation - 0.5) * 10;
              tooltipLines.push("Temp: ~" + adjTemp.toFixed(0) + "\u00B0C");
            }
            if (climateData.rainfall != null) {
              // Moisture estimate based on biome and rainfall
              var moisture = parseFloat(climateData.rainfall) / 100;
              if (tile.isWetland || tile.isWater) moisture = Math.min(1, moisture + 0.3);
              if (tile.isDesert) moisture = Math.max(0, moisture - 0.3);
              tooltipLines.push("Moisture: " + moisture.toFixed(2));
            }
            tooltipLines.push("Pos: " + Math.round(worldX) + ", " + Math.round(worldY));

          } else if (mapView === "social") {
            tooltipLines.push(biome);
            // Find citizens nearby this tile
            var nearby = [];
            citizens.forEach(function (c) {
              var pos = citizenPositions[c.id];
              if (!pos) return;
              var cd = Math.sqrt((pos.x - worldX) * (pos.x - worldX) + (pos.y - worldY) * (pos.y - worldY));
              if (cd < 2000) nearby.push({ name: c.name, dist: cd });
            });
            nearby.sort(function (a, b) { return a.dist - b.dist; });
            if (nearby.length > 0) {
              tooltipLines.push("Nearby citizens:");
              nearby.slice(0, 4).forEach(function (n) {
                tooltipLines.push("  " + n.name + " (" + Math.round(n.dist) + " away)");
              });
            } else {
              tooltipLines.push("No citizens nearby");
            }

          } else if (mapView === "resources") {
            tooltipLines.push(biome);
            tooltipLines.push("Terrain: " + terrainType);
            // Estimate food availability by biome type
            var resources = [];
            if (tile.isForest) resources.push("wood, berries, mushrooms");
            else if (tile.isMeadow) resources.push("herbs, seeds, roots");
            else if (tile.isWetland) resources.push("reeds, fish, clay");
            else if (tile.isWater) resources.push("fish, freshwater");
            else if (tile.isCoast) resources.push("shellfish, salt, driftwood");
            else if (tile.isRock) resources.push("stone, ore, cave shelter");
            else if (tile.isDesert) resources.push("sparse — cacti, lizards");
            else if (tile.isTundra) resources.push("sparse — lichen, snow hare");
            else resources.push("grass, small game");
            if (resources.length > 0) tooltipLines.push("Resources: " + resources.join("; "));
            // Flora data
            if (state && state.flora) {
              var fl = state.flora;
              if (fl.total_plants != null) tooltipLines.push("Flora density: " + (tile.isForest ? "high" : tile.isMeadow ? "medium" : tile.isDesert || tile.isTundra ? "low" : "moderate"));
            }

          } else if (mapView === "danger") {
            tooltipLines.push(biome);
            // Check predator proximity
            var predNear = false;
            var nearestPredDist = Infinity;
            if (state && state.fauna) {
              var dp = state.fauna.predator_positions;
              if (typeof dp === "string") { try { dp = JSON.parse(dp); } catch (_) { dp = null; } }
              if (Array.isArray(dp)) {
                dp.forEach(function (p) {
                  if (!p || p.x == null || p.y == null) return;
                  var pd = Math.sqrt((p.x - worldX) * (p.x - worldX) + (p.y - worldY) * (p.y - worldY));
                  if (pd < nearestPredDist) nearestPredDist = pd;
                  if (pd < 3000) predNear = true;
                });
              }
            }
            if (predNear) {
              tooltipLines.push("Threat: HIGH");
              tooltipLines.push("Predator: " + Math.round(nearestPredDist) + " away");
            } else if (nearestPredDist < 8000) {
              tooltipLines.push("Threat: MODERATE");
              tooltipLines.push("Predator: " + Math.round(nearestPredDist) + " away");
            } else {
              tooltipLines.push("Threat: LOW");
            }
            // Terrain hazards
            if (tile.isWater) tooltipLines.push("Hazard: drowning risk");
            if (tile.elevation > 0.7) tooltipLines.push("Hazard: steep terrain");
            if (tile.isTundra) tooltipLines.push("Hazard: cold exposure");
          }
        }
      }

      if (tooltipLines.length > 0) {
        drawTooltip(ctx, mapMouseX, mapMouseY, tooltipLines, cssW, cssH);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Relationship Web (Force-Directed Graph)
  // ---------------------------------------------------------------------------

  function drawRelationshipWeb() {
    var canvas = byId("rel-canvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.width / dpr;
    var h = canvas.height / dpr;
    if (w < 1 || h < 1) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (!state) { ctx.restore(); return; }

    var citizens = getCitizens();
    var relationships = state.relationships || [];
    if (citizens.length === 0) { ctx.restore(); return; }

    // Build/update force nodes
    if (!forceInitialized || forceNodes.length !== citizens.length) {
      forceNodes = citizens.map(function (c, i) {
        var angle = (i / citizens.length) * Math.PI * 2;
        var r = Math.min(w, h) * 0.32;
        return {
          id: c.id, name: c.name, sex: c.sex,
          x: w / 2 + Math.cos(angle) * r,
          y: h / 2 + Math.sin(angle) * r,
          vx: 0, vy: 0
        };
      });
      forceInitialized = true;
    }

    // Update metadata
    var citizenMap = {};
    citizens.forEach(function (c) { citizenMap[c.id] = c; });
    forceNodes.forEach(function (n) {
      var c = citizenMap[n.id];
      if (c) { n.name = c.name; n.sex = c.sex; }
    });

    // Vocab sizes for node sizing
    var vocabSizes = {};
    citizens.forEach(function (c) {
      vocabSizes[c.id] = (state.lexicon_by_citizen && state.lexicon_by_citizen[c.id])
        ? state.lexicon_by_citizen[c.id].length : 0;
    });

    // Deduplicate relationships
    var relMap = {};
    relationships.forEach(function (r) {
      var k = [r.citizen_a, r.citizen_b].sort().join(":");
      if (!relMap[k] || Math.abs(r.score) > Math.abs(relMap[k].score)) relMap[k] = r;
    });

    setText("rel-count", Object.keys(relMap).length + " bonds");

    var nodeMap = {};
    forceNodes.forEach(function (n) { nodeMap[n.id] = n; });

    // Force simulation
    for (var i = 0; i < forceNodes.length; i++) {
      for (var j = i + 1; j < forceNodes.length; j++) {
        var a = forceNodes[i], b = forceNodes[j];
        var dx = b.x - a.x, dy = b.y - a.y;
        var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        var f = 600 / (dist * dist);
        var fx = (dx / dist) * f, fy = (dy / dist) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Attraction from relationships
    for (var rk in relMap) {
      var rel = relMap[rk];
      var na = nodeMap[rel.citizen_a], nb = nodeMap[rel.citizen_b];
      if (!na || !nb) continue;
      var rdx = nb.x - na.x, rdy = nb.y - na.y;
      var rdist = Math.max(1, Math.sqrt(rdx * rdx + rdy * rdy));
      var str = Math.abs(rel.score) * 0.02;
      var ideal = 50 + (1 - Math.abs(rel.score)) * 70;
      var rf = (rdist - ideal) * str;
      na.vx += (rdx / rdist) * rf;
      na.vy += (rdy / rdist) * rf;
      nb.vx -= (rdx / rdist) * rf;
      nb.vy -= (rdy / rdist) * rf;
    }

    // Center gravity and apply
    forceNodes.forEach(function (n) {
      n.vx += (w / 2 - n.x) * 0.005;
      n.vy += (h / 2 - n.y) * 0.005;
      n.vx *= 0.85;
      n.vy *= 0.85;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(30, Math.min(w - 30, n.x));
      n.y = Math.max(25, Math.min(h - 25, n.y));
    });

    // Draw edges
    for (var ek in relMap) {
      var er = relMap[ek];
      var ea = nodeMap[er.citizen_a], eb = nodeMap[er.citizen_b];
      if (!ea || !eb) continue;
      var thick = Math.max(0.5, Math.abs(er.score) * 3.5);
      var alpha = Math.min(0.8, Math.abs(er.score) * 0.6 + 0.15);
      var col;
      if (er.type === "rivalry" || er.type === "estranged")
        col = "rgba(196,74,32," + alpha + ")";
      else if (er.type === "mentorship")
        col = "rgba(90,155,186," + alpha + ")";
      else if (er.type === "romantic")
        col = "rgba(196,100,140," + alpha + ")";
      else if (er.score >= 0)
        col = "rgba(74,158,110," + alpha + ")";
      else
        col = "rgba(196,74,32," + alpha + ")";

      ctx.strokeStyle = col;
      ctx.lineWidth = thick;
      ctx.beginPath();
      ctx.moveTo(ea.x, ea.y);
      ctx.lineTo(eb.x, eb.y);
      ctx.stroke();
    }

    // Draw nodes
    forceNodes.forEach(function (n) {
      var colors = CITIZEN_COLORS[n.sex] || CITIZEN_COLORS.male;
      var vocabCount = vocabSizes[n.id] || 0;
      var r = Math.max(5, 5 + vocabCount * 0.8);
      r = Math.min(r, 16);

      // Glow
      var grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 2.5);
      grad.addColorStop(0, colors.glow);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(n.x - r * 3, n.y - r * 3, r * 6, r * 6);

      // Dot
      ctx.fillStyle = colors.base;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.fillStyle = "rgba(240,224,204,0.9)";
      ctx.font = "10px 'Inter', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(n.name, n.x, n.y - r - 5);
    });

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Overview Metrics
  // ---------------------------------------------------------------------------

  function updateOverviewMetrics() {
    var ls = state.live_state || {};
    var civ = ls.civilization || {};
    var ustats = state.utterance_stats || {};

    var vocabSize = state.shared_lexicon ? state.shared_lexicon.length : (civ.shared_vocabulary_size || 0);
    setText("metric-vocab-size", String(vocabSize));

    var totalU = ustats.total_utterances || 0;
    var successfulU = ustats.successful || 0;
    var rate = totalU > 0 ? ((successfulU / totalU) * 100).toFixed(1) : "0.0";
    setText("metric-success-rate", rate + "%");

    setText("metric-total-interactions", formatNumber(state.total_interactions || 0));

    var citizens = getCitizens();
    var activeCitizens = citizens.filter(function (c) { return c.status !== "sleeping"; });
    setText("metric-active-citizens", String(activeCitizens.length));

    updateTrendEl("metric-vocab-trend", history.vocab_size);
    updateTrendEl("metric-success-trend", history.success_rate);
  }

  function updateTrendEl(id, arr) {
    var el = byId(id);
    if (!el) return;
    if (arr.length < 2) {
      el.textContent = "--";
      el.className = "metric-trend neutral";
      return;
    }
    var recent = arr.slice(-5);
    var older = arr.slice(-10, -5);
    if (older.length === 0) { el.textContent = "--"; el.className = "metric-trend neutral"; return; }
    var avgR = recent.reduce(function (s, v) { return s + v; }, 0) / recent.length;
    var avgO = older.reduce(function (s, v) { return s + v; }, 0) / older.length;
    var diff = avgR - avgO;
    if (Math.abs(diff) < 0.01) {
      el.textContent = "-- Stable";
      el.className = "metric-trend neutral";
    } else if (diff > 0) {
      el.textContent = "^ Trending up";
      el.className = "metric-trend up";
    } else {
      el.textContent = "v Trending down";
      el.className = "metric-trend down";
    }
  }

  // ---------------------------------------------------------------------------
  // Visual Dashboard Cards (Overview bottom grid)
  // ---------------------------------------------------------------------------

  function updateDashCards() {
    if (!state) return;
    var ls = state.live_state || {};
    var civ = ls.civilization || {};

    // World info
    var worlds = state.worlds || [];
    var active = worlds.find(function(w) { return w.status === "active"; });
    if (active) {
        setText("dash-world-info", "World " + active.world_id + " — Active");
        setText("dash-world-title", "WORLD " + active.world_id);
        var wb = byId("world-badge");
        if (wb) wb.textContent = "World " + active.world_id;
    }

    // Key numbers
    var citizens = getCitizens();
    setText("dash-tick", ls.tick || 0);
    // Count from citizens_db which now includes both alive and dead
    var allCitizens = state.citizens_db || [];
    var aliveCount = allCitizens.filter(function(c){ return c.alive === true; }).length;
    var deadCount = allCitizens.filter(function(c){ return c.alive === false; }).length;
    setText("dash-alive", aliveCount);
    setText("dash-dead", deadCount);
    setText("dash-vocab", state.shared_lexicon ? state.shared_lexicon.length : 0);
    setText("dash-interactions", state.total_interactions || 0);
    setText("dash-voices", (state.voice_clips || []).length);

    // Climate
    var climate = state.climate || {};
    setText("dash-season", ls.season || climate.season || "--");
    setText("dash-temp", (climate.temperature_avg != null ? Math.round(climate.temperature_avg) + "\u00B0C" : "--"));
    setText("dash-weather", ls.weather || "--");
    setText("dash-time", ls.time_of_day || "--");

    // Survival bars (average from citizens)
    if (citizens.length > 0) {
        var avgH = 0, avgT = 0, avgHe = 0, count = 0;
        citizens.forEach(function(c) {
            if (c.hunger != null) { avgH += parseFloat(c.hunger); count++; }
            if (c.thirst != null) avgT += parseFloat(c.thirst);
            if (c.health != null) avgHe += parseFloat(c.health);
        });
        if (count > 0) {
            var hungerPct = (avgH / count > 1) ? (avgH / count) : (avgH / count * 100);
            var thirstPct = (avgT / count > 1) ? (avgT / count) : (avgT / count * 100);
            var healthPct = (avgHe / count > 1) ? (avgHe / count) : (avgHe / count * 100);
            var hBar = byId("dash-hunger"); if (hBar) hBar.style.width = Math.min(100, Math.max(0, hungerPct)).toFixed(0) + "%";
            var tBar = byId("dash-thirst"); if (tBar) tBar.style.width = Math.min(100, Math.max(0, thirstPct)).toFixed(0) + "%";
            var heBar = byId("dash-health"); if (heBar) heBar.style.width = Math.min(100, Math.max(0, healthPct)).toFixed(0) + "%";
        }
    }

    // Archetypes breakdown
    var archDiv = byId("dash-archetypes");
    if (archDiv) {
        var archCounts = {};
        citizens.forEach(function(c) { var r = c.role || "unknown"; archCounts[r] = (archCounts[r]||0)+1; });
        archDiv.textContent = "";
        Object.keys(archCounts).sort().forEach(function(arch) {
            var row = createEl("div", "dash-stat");
            row.appendChild(createEl("span", "dash-stat-label", arch));
            row.appendChild(createEl("span", "dash-stat-val", String(archCounts[arch])));
            archDiv.appendChild(row);
        });
    }

    // Language
    setText("dash-shared-words", state.shared_lexicon ? state.shared_lexicon.length : 0);
    setText("dash-total-sounds", state.total_lexicon_entries || 0);
    var ustats = state.utterance_stats || {};
    var rate = ustats.total_utterances > 0 ? Math.round(ustats.successful / ustats.total_utterances * 100) : 0;
    setText("dash-success-rate", rate + "%");

    // Milestones
    var msDiv = byId("dash-milestones");
    if (msDiv) {
        var milestones = state.milestones || [];
        if (milestones.length > 0) {
            msDiv.textContent = "";
            milestones.forEach(function(m) {
                var badge = createEl("span", "milestone-badge");
                badge.textContent = m.milestone + " (T" + m.tick + ")";
                msDiv.appendChild(badge);
            });
        }
    }

    // Voice clips
    var voiceDiv = byId("dash-voice-list");
    var clips = state.voice_clips || [];
    setText("dash-voice-count", clips.length + " clips");
    if (voiceDiv && clips.length > 0) {
        voiceDiv.textContent = "";
        clips.forEach(function(clip) {
            var row = createEl("div", "dash-stat");
            row.style.cssText = "gap:6px;align-items:center";
            var playBtn = createPlayBtn(clip.sound);
            row.appendChild(playBtn);
            var soundSpan = createEl("span", null, clip.sound);
            soundSpan.style.cssText = "font-family:var(--font-mono);color:var(--accent-amber);font-weight:600;font-size:0.9rem";
            row.appendChild(soundSpan);
            var meaning = createEl("span", "dash-stat-label", clip.meaning || "");
            row.appendChild(meaning);
            voiceDiv.appendChild(row);
        });
    }

    // World history table
    var histBody = byId("dash-world-history-body");
    if (histBody) {
        var worlds = (state.worlds || []).slice().sort(function(a,b) { return b.world_id - a.world_id; });
        histBody.textContent = "";
        worlds.forEach(function(w) {
            var tr = document.createElement("tr");
            var isActive = w.status === "active";

            var tdId = document.createElement("td");
            tdId.textContent = "W" + w.world_id;
            tdId.style.cssText = "font-family:var(--font-mono);font-weight:700;" + (isActive ? "color:var(--accent-amber)" : "");
            tr.appendChild(tdId);

            var tdStatus = document.createElement("td");
            tdStatus.textContent = w.status;
            tdStatus.style.color = isActive ? "var(--accent-green)" : "var(--text-muted)";
            tr.appendChild(tdStatus);

            var tdTicks = document.createElement("td");
            tdTicks.textContent = w.ticks || 0;
            tdTicks.style.cssText = "font-family:var(--font-mono)";
            tr.appendChild(tdTicks);

            var tdInt = document.createElement("td");
            tdInt.textContent = w.interactions || 0;
            tdInt.style.cssText = "font-family:var(--font-mono)";
            tr.appendChild(tdInt);

            var tdWords = document.createElement("td");
            tdWords.textContent = w.shared_words || 0;
            tdWords.style.cssText = "font-family:var(--font-mono)";
            tr.appendChild(tdWords);

            var tdMs = document.createElement("td");
            tdMs.textContent = w.milestones || 0;
            tdMs.style.cssText = "font-family:var(--font-mono)";
            tr.appendChild(tdMs);

            histBody.appendChild(tr);
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Chart.js Dashboard Charts (Overview tab)
  // ---------------------------------------------------------------------------

  var _chartInstances = {};

  function updateDashCharts() {
    if (!state || typeof Chart === "undefined") return;

    var citizens = getCitizens();
    var chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      animation: { duration: 400 },
    };
    var fontColor = "#6a6070";
    var gridColor = "rgba(30,30,42,0.5)";

    // 1. Survival Radar
    safe("dashChart/survivalRadar", function() {
      var avgH = 0, avgT = 0, avgHe = 0, avgE = 0, avgM = 0, n = 0;
      var hasHunger = false, hasThirst = false, hasHealth = false;
      citizens.forEach(function(c) {
        if (c.hunger != null) { avgH += parseFloat(c.hunger); hasHunger = true; }
        if (c.thirst != null) { avgT += parseFloat(c.thirst); hasThirst = true; }
        if (c.health != null) { avgHe += parseFloat(c.health); hasHealth = true; }
        avgE += parseFloat(c.energy || 0.5);
        avgM += Math.max(0, parseFloat(c.mood || 0) + 1) / 2;
        n++;
      });
      if (n === 0) return;
      // Fallback to tribe-level survival summary if per-citizen fields missing
      var surv = (state.live_state || {}).survival || {};
      if (!hasHunger) avgH = surv.avg_hunger != null ? surv.avg_hunger * n : 0.75 * n;
      if (!hasThirst) avgT = surv.avg_thirst != null ? surv.avg_thirst * n : 0.75 * n;
      if (!hasHealth) avgHe = surv.avg_health != null ? surv.avg_health * n : 0.9 * n;
      var vals = [avgH/n, avgT/n, avgHe/n, avgE/n, avgM/n];

      if (_chartInstances.survivalRadar) {
        _chartInstances.survivalRadar.data.datasets[0].data = vals;
        _chartInstances.survivalRadar.update("none");
      } else {
        var ctx = byId("chart-survival-radar");
        if (!ctx) return;
        _chartInstances.survivalRadar = new Chart(ctx, {
          type: "radar",
          data: {
            labels: ["Hunger", "Thirst", "Health", "Energy", "Mood"],
            datasets: [{
              data: vals,
              backgroundColor: "rgba(212,165,116,0.15)",
              borderColor: "#d4a574",
              borderWidth: 2,
              pointBackgroundColor: "#d4a574",
              pointRadius: 3,
            }]
          },
          options: Object.assign({}, chartDefaults, {
            scales: {
              r: {
                min: 0, max: 1,
                grid: { color: gridColor },
                angleLines: { color: gridColor },
                pointLabels: { color: fontColor, font: { size: 10, family: "'JetBrains Mono', monospace" } },
                ticks: { display: false },
              }
            }
          })
        });
      }
    });

    // 2. Archetype Doughnut
    safe("dashChart/archetypeDoughnut", function() {
      var archCounts = {};
      citizens.forEach(function(c) {
        var r = c.role || "unknown";
        archCounts[r] = (archCounts[r] || 0) + 1;
      });
      var labels = Object.keys(archCounts).sort();
      var values = labels.map(function(k) { return archCounts[k]; });
      var colors = ["#c44a20","#4a9e6e","#5a9bba","#8a6abf","#c4648c","#d4a574","#4ac4c4","#d4c454"];

      if (_chartInstances.archetypeDoughnut) {
        _chartInstances.archetypeDoughnut.data.labels = labels;
        _chartInstances.archetypeDoughnut.data.datasets[0].data = values;
        _chartInstances.archetypeDoughnut.update("none");
      } else {
        var ctx = byId("chart-archetype-doughnut");
        if (!ctx) return;
        _chartInstances.archetypeDoughnut = new Chart(ctx, {
          type: "doughnut",
          data: {
            labels: labels,
            datasets: [{
              data: values,
              backgroundColor: colors.slice(0, labels.length),
              borderColor: "#12121a",
              borderWidth: 2,
            }]
          },
          options: Object.assign({}, chartDefaults, {
            cutout: "55%",
            plugins: {
              legend: {
                display: true,
                position: "right",
                labels: { color: fontColor, font: { size: 9, family: "'JetBrains Mono', monospace" }, boxWidth: 10, padding: 6 }
              }
            }
          })
        });
      }
    });

    // 3. Vocab Sparkline (Chart.js line)
    safe("dashChart/vocabSparkline", function() {
      var snaps = state.snapshots || [];
      if (snaps.length < 2) return;
      var labels = snaps.map(function(s) { return s.tick; });
      var vocabData = snaps.map(function(s) { return s.shared_vocab_size || 0; });

      if (_chartInstances.vocabSparkline) {
        _chartInstances.vocabSparkline.data.labels = labels;
        _chartInstances.vocabSparkline.data.datasets[0].data = vocabData;
        _chartInstances.vocabSparkline.update("none");
      } else {
        var ctx = byId("chart-vocab-sparkline");
        if (!ctx) return;
        _chartInstances.vocabSparkline = new Chart(ctx, {
          type: "line",
          data: {
            labels: labels,
            datasets: [{
              data: vocabData,
              borderColor: "#4a9e6e",
              backgroundColor: "rgba(74,158,110,0.1)",
              fill: true,
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.4,
            }]
          },
          options: Object.assign({}, chartDefaults, {
            scales: {
              x: { display: false },
              y: { display: false, beginAtZero: true },
            }
          })
        });
      }
    });

    // 4. Population Trend
    safe("dashChart/populationTrend", function() {
      var snaps = state.snapshots || [];
      if (snaps.length < 2) return;
      var labels = snaps.map(function(s) { return "T" + s.tick; });
      var alive = snaps.map(function(s) { return s.alive_count || 0; });
      var dead = snaps.map(function(s) { return s.dead_count || 0; });

      if (_chartInstances.populationTrend) {
        _chartInstances.populationTrend.data.labels = labels;
        _chartInstances.populationTrend.data.datasets[0].data = alive;
        _chartInstances.populationTrend.data.datasets[1].data = dead;
        _chartInstances.populationTrend.update("none");
      } else {
        var ctx = byId("chart-population-trend");
        if (!ctx) return;
        _chartInstances.populationTrend = new Chart(ctx, {
          type: "line",
          data: {
            labels: labels,
            datasets: [
              { label: "Alive", data: alive, borderColor: "#4a9e6e", backgroundColor: "rgba(74,158,110,0.1)", fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
              { label: "Dead", data: dead, borderColor: "#c44a20", backgroundColor: "rgba(196,74,32,0.08)", fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
            ]
          },
          options: Object.assign({}, chartDefaults, {
            plugins: {
              legend: { display: true, position: "top", labels: { color: fontColor, font: { size: 9 }, boxWidth: 10 } }
            },
            scales: {
              x: { display: true, grid: { color: gridColor }, ticks: { color: fontColor, font: { size: 8 }, maxTicksLimit: 6 } },
              y: { display: true, beginAtZero: true, grid: { color: gridColor }, ticks: { color: fontColor, font: { size: 9 } } },
            }
          })
        });
      }
    });

    // 5. World History Bar Chart
    safe("dashChart/worldHistoryBar", function() {
      var worlds = (state.worlds || []).slice().sort(function(a,b) { return a.world_id - b.world_id; });
      if (worlds.length < 2) return;
      var labels = worlds.map(function(w) { return "W" + w.world_id; });
      var ticks = worlds.map(function(w) { return w.ticks || 0; });
      var interactions = worlds.map(function(w) { return w.interactions || 0; });

      if (_chartInstances.worldHistoryBar) {
        _chartInstances.worldHistoryBar.data.labels = labels;
        _chartInstances.worldHistoryBar.data.datasets[0].data = ticks;
        _chartInstances.worldHistoryBar.data.datasets[1].data = interactions;
        _chartInstances.worldHistoryBar.update("none");
      } else {
        var ctx = byId("chart-world-history-bar");
        if (!ctx) return;
        _chartInstances.worldHistoryBar = new Chart(ctx, {
          type: "bar",
          data: {
            labels: labels,
            datasets: [
              { label: "Ticks", data: ticks, backgroundColor: "rgba(90,155,186,0.7)", borderRadius: 3 },
              { label: "Interactions", data: interactions, backgroundColor: "rgba(212,165,116,0.7)", borderRadius: 3 },
            ]
          },
          options: Object.assign({}, chartDefaults, {
            plugins: {
              legend: { display: true, position: "top", labels: { color: fontColor, font: { size: 9 }, boxWidth: 10 } }
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: fontColor, font: { size: 8, family: "'JetBrains Mono', monospace" } } },
              y: { grid: { color: gridColor }, ticks: { color: fontColor, font: { size: 9 } } },
            }
          })
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Ecosystem Panel
  // ---------------------------------------------------------------------------

  function updateEcosystem() {
    if (!state) return;

    var climate = state.climate;
    var flora = state.flora;
    var fauna = state.fauna;
    var deaths = state.deaths || [];

    // Temperature
    if (climate && climate.temperature_avg != null) {
      setText("eco-temp", parseFloat(climate.temperature_avg).toFixed(1) + "\u00B0C");
    } else {
      setText("eco-temp", "--");
    }

    // Season — prefer climate data, fall back to live_state
    if (climate && climate.season) {
      setText("eco-season", climate.season);
    } else {
      var ls = state.live_state || {};
      setText("eco-season", ls.season || "--");
    }

    // Rainfall
    if (climate && climate.rainfall != null) {
      setText("eco-rain", parseFloat(climate.rainfall).toFixed(1) + " mm");
    } else {
      setText("eco-rain", "--");
    }

    // Hunger and thirst bars — compute averages from citizen data
    var citizens = getCitizens();
    var totalHunger = 0;
    var totalThirst = 0;
    var hungerCount = 0;
    var thirstCount = 0;

    citizens.forEach(function (c) {
      if (c.hunger != null) { totalHunger += parseFloat(c.hunger); hungerCount++; }
      if (c.thirst != null) { totalThirst += parseFloat(c.thirst); thirstCount++; }
    });

    // Also check live_state citizens for survival fields
    var lsCitizens = (state.live_state && state.live_state.citizens) || [];
    lsCitizens.forEach(function (c) {
      if (c.hunger != null && hungerCount === 0) { totalHunger += parseFloat(c.hunger); hungerCount++; }
      if (c.thirst != null && thirstCount === 0) { totalThirst += parseFloat(c.thirst); thirstCount++; }
    });

    var avgHunger = hungerCount > 0 ? totalHunger / hungerCount : 0;
    var avgThirst = thirstCount > 0 ? totalThirst / thirstCount : 0;

    // Hunger/thirst are typically 0-1 where 1 = full, or could be 0-100
    // Normalize to percentage: if max > 1 assume 0-100 scale
    var hungerPct = avgHunger > 1 ? avgHunger : avgHunger * 100;
    var thirstPct = avgThirst > 1 ? avgThirst : avgThirst * 100;

    var hungerBar = byId("eco-hunger-bar");
    var thirstBar = byId("eco-thirst-bar");
    if (hungerBar) hungerBar.style.width = Math.min(100, Math.max(0, hungerPct)).toFixed(0) + "%";
    if (thirstBar) thirstBar.style.width = Math.min(100, Math.max(0, thirstPct)).toFixed(0) + "%";

    // Deaths count
    setText("eco-deaths", String(deaths.length));
  }

  // ---------------------------------------------------------------------------
  // Sparklines
  // ---------------------------------------------------------------------------

  function drawSparklines() {
    drawSparkline("sparkline-vocab", history.vocab_size, "#d4a574");
    drawSparkline("sparkline-success", history.success_rate, "#4a9e6e");
  }

  function drawSparkline(canvasId, data, color) {
    var canvas = byId(canvasId);
    if (!canvas || data.length < 2) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    if (w < 1 || h < 1) return;

    ctx.clearRect(0, 0, w, h);
    var min = Math.min.apply(null, data);
    var max = Math.max.apply(null, data);
    var range = max - min || 1;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    data.forEach(function (v, i) {
      var x = (i / (data.length - 1)) * w;
      var y = h - ((v - min) / range) * (h * 0.75) - h * 0.12;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Area fill
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = color + "18";
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Live Feed
  // ---------------------------------------------------------------------------

  // Content-based dedup: normalize text to catch same event from different sources
  function _feedContentKey(text, tick) {
    var normalized = (text || "").replace(/\s+/g, " ").trim().toLowerCase().substring(0, 80);
    return "c:" + tick + ":" + normalized;
  }

  function updateLiveFeed() {
    var feed = byId("live-feed");
    if (!feed) return;

    var interactions = state.interactions || [];
    var worldEvents = state.world_events || [];
    var milestones = state.milestones || [];
    var narratives = state.narratives || [];
    var newEntries = [];

    // Interactions
    interactions.forEach(function (item) {
      var key = "int:" + item.id;
      if (seenInteractionIds.has(key)) return;
      seenInteractionIds.add(key);
      newEntries.push({ type: "speech", tick: item.tick || 0, data: item });
    });

    // World events
    worldEvents.forEach(function (item) {
      var key = "evt:" + item.id;
      if (seenEventIds.has(key)) return;
      seenEventIds.add(key);
      // Content-dedup: narratives often repeat the same event text
      var contentKey = _feedContentKey(item.description, item.tick);
      if (seenEventIds.has(contentKey)) return;
      seenEventIds.add(contentKey);
      var t = item.event_type === "milestone" ? "milestone" : "world";
      newEntries.push({ type: t, tick: item.tick || 0, data: item });
    });

    // Milestones
    milestones.forEach(function (item) {
      var key = "ms:" + item.milestone;
      if (seenEventIds.has(key)) return;
      seenEventIds.add(key);
      newEntries.push({
        type: "milestone", tick: item.tick || 0,
        data: { tick: item.tick, description: item.milestone + ": " + (item.description || ""), affected_citizens: [] }
      });
    });

    // Narratives — skip if content already shown via world_events
    narratives.forEach(function (item) {
      var key = "nar:" + item.id;
      if (seenEventIds.has(key)) return;
      seenEventIds.add(key);
      // Content-dedup: skip if same text already in feed from world_events
      var contentKey = _feedContentKey(item.text, item.tick);
      if (seenEventIds.has(contentKey)) return;
      seenEventIds.add(contentKey);
      var ntype = item.type || "world";
      if (ntype === "interaction") ntype = "speech";
      if (ntype === "language_transfer") ntype = "transfer";
      newEntries.push({ type: ntype, tick: item.tick || 0, data: item, isNarrative: true });
    });

    // --- CHANGE 2: Detect new shared lexicon words (word births) ---
    var _wordBirthCards = [];
    var _currentLexSounds = (state.shared_lexicon || []).map(function(w) { return w.sound; });
    var _prevSoundsSet = {};
    _prevSharedLexicon.forEach(function(s) { _prevSoundsSet[s] = true; });
    if (_prevSharedLexicon.length > 0) {
      // Find genuinely new words
      (state.shared_lexicon || []).forEach(function(w) {
        if (!_prevSoundsSet[w.sound]) {
          _wordBirthCards.push(w);
        }
      });
    }
    _prevSharedLexicon = _currentLexSounds.slice();

    // --- CHANGE 5: Detect new deaths ---
    var _deathCards = [];
    var _currentDeathIds = (state.deaths || []).map(function(d) { return d.id || d.citizen_id; });
    var _prevDeathsSet = {};
    _prevDeaths.forEach(function(id) { _prevDeathsSet[id] = true; });
    if (_prevDeaths.length > 0) {
      (state.deaths || []).forEach(function(d) {
        var did = d.id || d.citizen_id;
        if (did && !_prevDeathsSet[did]) {
          _deathCards.push(d);
        }
      });
    }
    _prevDeaths = _currentDeathIds.slice();

    var hasNewContent = newEntries.length > 0 || _wordBirthCards.length > 0 || _deathCards.length > 0;
    if (!hasNewContent) return;

    var loading = byId("feed-loading");
    if (loading) loading.style.display = "none";

    // Sort new entries newest-first by tick
    newEntries.sort(function (a, b) { return b.tick - a.tick; });

    // Build DOM elements and PREPEND to feed (newest at top, no re-sorting existing)
    var fragment = document.createDocumentFragment();

    // Word birth cards go first (most prominent)
    _wordBirthCards.forEach(function(w) {
      var ls = state.live_state || {};
      var currentTick = ls.tick || 0;
      var wbDiv = createEl("div", "feed-entry type-milestone fresh");
      var card = createEl("div", "feed-word-birth");
      card.appendChild(createEl("div", "feed-wb-eyebrow", "\u25CE NEW WORD BORN  \u00B7  Tick " + currentTick));
      var sound = createEl("span", "feed-wb-sound", "\u201C" + w.sound + "\u201D");
      card.appendChild(sound);
      card.appendChild(createEl("div", "feed-wb-meaning", "= " + (w.meaning || "?").toUpperCase()));
      var knownBy = w.citizen_count || (w.established_by ? w.established_by.length : 1);
      var conf = w.confidence != null ? (w.confidence * 100).toFixed(0) + "%" : "?";
      card.appendChild(createEl("div", "feed-wb-stats", "Known by " + knownBy + " citizen" + (knownBy !== 1 ? "s" : "") + " \u00B7 confidence " + (w.confidence != null ? w.confidence.toFixed(2) : "?")));
      card.appendChild(createEl("div", "feed-wb-prose", "The tribe has named something."));
      wbDiv.appendChild(card);
      fragment.appendChild(wbDiv);
    });

    // Death cards
    _deathCards.forEach(function(d) {
      var ls = state.live_state || {};
      var currentTick = ls.tick || 0;
      var deathDiv = createEl("div", "feed-entry type-death fresh");
      var card = createEl("div", "feed-death-card");

      // Header
      var dHeader = createEl("div", "feed-death-header");
      var cross = createEl("span", "feed-death-cross", "\u2020");
      dHeader.appendChild(cross);
      dHeader.appendChild(document.createTextNode(findCitizenName(d.id || d.citizen_id) + "  \u00B7  " + (d.role || "citizen") + "  \u00B7  age " + (d.age || "?")));
      card.appendChild(dHeader);

      // Meta
      var cause = d.cause || "unknown";
      var worldId = (state.live_state || {}).world_id || "?";
      card.appendChild(createEl("div", "feed-death-meta", "Cause: " + cause + "  \u00B7  Tick " + (d.tick || currentTick) + "\nSurvived " + (d.age || "?") + " ticks in World " + worldId));

      // Legacy: words they taught that others still use
      var legacyDiv = createEl("div", "feed-death-legacy");
      var sharedLex = state.shared_lexicon || [];
      var citizenId = d.id || d.citizen_id;
      var taughtWords = sharedLex.filter(function(w) {
        return w.established_by && Array.isArray(w.established_by) && w.established_by.indexOf(citizenId) !== -1;
      });
      if (taughtWords.length > 0) {
        var lexByCit = state.lexicon_by_citizen || {};
        var livingCitizens = getCitizens();
        var taughtLine = document.createElement("div");
        var firstWord = taughtWords[0];
        var usersCount = 0;
        livingCitizens.forEach(function(lc) {
          var lv = lexByCit[lc.id] || [];
          lv.forEach(function(v) { if (v.sound === firstWord.sound) usersCount++; });
        });
        var strong = createEl("strong", null, "\u201C" + firstWord.sound + "\u201D");
        taughtLine.appendChild(document.createTextNode("Words they taught that live on: "));
        taughtLine.appendChild(strong);
        taughtLine.appendChild(document.createTextNode(" (" + usersCount + " citizen" + (usersCount !== 1 ? "s" : "") + " still use it)"));
        legacyDiv.appendChild(taughtLine);
      }

      // Closest bond
      var allRels = state.relationships || [];
      var myRels = allRels.filter(function(r) { return r.citizen_a === citizenId || r.citizen_b === citizenId; });
      myRels.sort(function(a, b) { return Math.abs(b.score) - Math.abs(a.score); });
      if (myRels.length > 0) {
        var top = myRels[0];
        var otherId = top.citizen_a === citizenId ? top.citizen_b : top.citizen_a;
        var bondLine = document.createElement("div");
        var bondStrong = createEl("strong", null, findCitizenName(otherId));
        bondLine.appendChild(document.createTextNode("Closest bond: "));
        bondLine.appendChild(bondStrong);
        bondLine.appendChild(document.createTextNode(" (" + (top.type || "neutral") + " \u00B7 " + top.score.toFixed(2) + ")"));
        legacyDiv.appendChild(bondLine);
      }

      card.appendChild(legacyDiv);
      deathDiv.appendChild(card);
      fragment.appendChild(deathDiv);
    });

    // Change 6: Sort narratives by drama_score — top 3 high drama first, rest chronological
    var narrativeEntries = newEntries.filter(function(e) { return e.isNarrative; });
    var nonNarrativeEntries = newEntries.filter(function(e) { return !e.isNarrative; });
    var topDrama = [], restNarratives = [];
    if (narrativeEntries.length > 0) {
      var sortedByDrama = narrativeEntries.slice().sort(function(a, b) {
        return (b.data.drama_score || 0) - (a.data.drama_score || 0);
      });
      topDrama = sortedByDrama.slice(0, 3).filter(function(e) { return (e.data.drama_score || 0) > 0; });
      var topDramaIds = {};
      topDrama.forEach(function(e) { topDramaIds[e.data.id] = true; });
      restNarratives = narrativeEntries.filter(function(e) { return !topDramaIds[e.data.id]; });
    }
    var orderedEntries = topDrama.concat(nonNarrativeEntries).concat(restNarratives);

    orderedEntries.forEach(function (entry) {
      var isHighDrama = entry.isNarrative && (entry.data.drama_score || 0) > 0 && topDrama.indexOf(entry) !== -1;
      var divClass = "feed-entry type-" + entry.type + " fresh";
      if (entry.isNarrative) divClass += " feed-item-narrative";
      if (isHighDrama) divClass += " feed-narrative-high";
      var div = createEl("div", divClass);
      if (feedFilter !== "all" && entry.type !== feedFilter) div.style.display = "none";
      var catLabels = { speech: "SPEECH", world: "EVENT", milestone: "MILESTONE", transfer: "LANGUAGE", attack: "DANGER", death: "DEATH", voice: "VOICE" };
      var catLabel = createSpan("feed-category cat-" + entry.type, catLabels[entry.type] || entry.type.toUpperCase());
      div.appendChild(catLabel);
      if (entry.isNarrative) {
        div.appendChild(createSpan("feed-tick", "T" + (entry.data.tick != null ? entry.data.tick : "?")));
        div.appendChild(document.createTextNode(" "));
        var narText = createSpan("feed-narrative feed-narrative-text", entry.data.text || "");
        if (!isHighDrama) {
          narText.style.cssText = "font-style:italic;color:var(--text-secondary);font-size:0.8rem";
        }
        div.appendChild(narText);
      } else if (entry.type === "speech") {
        buildInteractionFeedEntry(div, entry.data);
      } else if (entry.type === "milestone") {
        buildMilestoneFeedEntry(div, entry.data);
      } else {
        buildWorldEventFeedEntry(div, entry.data);
      }
      fragment.appendChild(div);
    });

    // Prepend all new entries at the top — existing entries stay in place
    feed.insertBefore(fragment, feed.firstChild);

    // Trim old entries from the BOTTOM (keep max FEED_MAX)
    var entries = feed.querySelectorAll(".feed-entry");
    while (entries.length > FEED_MAX) {
      entries[entries.length - 1].remove();
      entries = feed.querySelectorAll(".feed-entry");
    }

    setText("feed-count", feed.querySelectorAll(".feed-entry").length + " events");
  }

  function buildInteractionFeedEntry(container, item) {
    var card = createEl("div", "feed-interaction-card");

    // Header row: names + tick
    var header = createEl("div", "feed-ic-header");
    var names = createEl("span", "feed-ic-names",
      findCitizenName(item.citizen_a) + " \u2192 " + findCitizenName(item.citizen_b));
    header.appendChild(names);
    header.appendChild(createEl("span", "feed-ic-tick", "T" + item.tick));
    card.appendChild(header);

    // Relationship badge from summary if present
    if (item.summary) {
      card.appendChild(createEl("div", "feed-ic-rel", item.summary));
    }

    // Two-column speech area
    var speeches = createEl("div", "feed-ic-speeches");
    var speechA = createEl("div", "feed-ic-speech" + (item.speech_a ? "" : " empty"));
    if (item.speech_a) {
      speechA.appendChild(buildClickableUtterance(item.speech_a));
    } else {
      speechA.textContent = "silent";
    }
    var speechB = createEl("div", "feed-ic-speech" + (item.speech_b ? "" : " empty"));
    if (item.speech_b) {
      speechB.appendChild(buildClickableUtterance(item.speech_b));
    } else {
      speechB.textContent = "silent";
    }
    speeches.appendChild(speechA);
    speeches.appendChild(speechB);
    card.appendChild(speeches);

    // Communication success bar
    // Derive from utterance_stats if available, else estimate from speech presence
    var successPct = 0;
    if (item.communication_success != null) {
      successPct = Math.round(item.communication_success * 100);
    } else if (state && state.utterance_stats) {
      var ustats = state.utterance_stats;
      successPct = ustats.total_utterances > 0
        ? Math.round((ustats.successful / ustats.total_utterances) * 100) : 0;
    } else {
      successPct = (item.speech_a && item.speech_b) ? 65 : item.speech_a ? 40 : 0;
    }
    var barColor = successPct >= 70 ? "#4a9e6e" : successPct >= 40 ? "#d4a574" : "#c44a20";
    var successRow = createEl("div", "feed-ic-success-row");
    var track = createEl("div", "feed-ic-bar-track");
    var fill = createEl("div", "feed-ic-bar-fill");
    fill.style.width = successPct + "%";
    fill.style.background = barColor;
    track.appendChild(fill);
    successRow.appendChild(track);
    successRow.appendChild(createEl("span", "feed-ic-pct", successPct + "% understood"));
    card.appendChild(successRow);

    container.appendChild(card);
  }

  // Build a feed utterance span with clickable words that have audio
  function buildClickableUtterance(speechText) {
    var wrapper = createEl("span", "feed-utterance");
    wrapper.appendChild(document.createTextNode("\u201C"));

    var words = speechText.split(/\s+/);
    for (var i = 0; i < words.length; i++) {
      if (i > 0) wrapper.appendChild(document.createTextNode(" "));
      var word = words[i];
      if (hasVoiceClip(word)) {
        var clickable = createEl("span", "feed-utterance-clickable", word);
        clickable.title = "Click to play audio";
        (function (w) {
          clickable.addEventListener("click", function () { playProtoSound(w); });
        })(word);
        wrapper.appendChild(clickable);
      } else {
        wrapper.appendChild(document.createTextNode(word));
      }
    }

    wrapper.appendChild(document.createTextNode("\u201D"));
    return wrapper;
  }

  function buildWorldEventFeedEntry(container, item) {
    container.appendChild(createSpan("feed-tick", "T" + item.tick));
    container.appendChild(createSpan("feed-icon", "*"));
    container.appendChild(createSpan("feed-world-text", item.description));
    if (item.affected_citizens && item.affected_citizens.length > 0) {
      var names = item.affected_citizens.map(findCitizenName).join(", ");
      container.appendChild(createEl("div", "feed-affected", "Affected: " + names));
    }
  }

  function buildMilestoneFeedEntry(container, item) {
    container.appendChild(createSpan("feed-tick", "T" + item.tick));
    container.appendChild(createSpan("feed-icon", "\u2B50"));
    container.appendChild(createSpan("feed-milestone-text", item.description));
  }

  function scrollFeedToBottom() {
    var feed = byId("live-feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // TAB 2: Citizens
  // ---------------------------------------------------------------------------

  // Track which tab is active per citizen, and which cards are expanded
  var citizenTabState = {};
  var citizenExpandState = {};

  function renderCitizensTab() {
    var grid = byId("citizens-grid");
    if (!grid) return;
    clearEl(grid);

    var citizens = getCitizens();
    citizens.forEach(function (c) {
      grid.appendChild(buildCitizenCard(c));
    });
  }

  function buildCitizenCard(c) {
    var cid = c.id;
    var isExpanded = citizenExpandState[cid] || false;
    var card = createEl("div", "citizen-card" + (isExpanded ? " expanded" : ""));

    // ---- HEADER BAR (always visible) ----
    var header = createEl("div", "citizen-header");

    // Colored dot (blue=male, amber=female)
    header.appendChild(createEl("div", "citizen-dot " + (c.sex || "male")));

    // Display name — e.g. "Male 36" or their name
    var displayName = c.name || ((c.sex || "Citizen") + " " + (c.age || "?"));
    header.appendChild(createEl("span", "citizen-name", displayName));

    // Archetype badge
    var role = (c.role || "unknown").toLowerCase();
    var badgeClass = "archetype-badge ";
    if (role === "alpha") badgeClass += "alpha";
    else if (role === "provider") badgeClass += "provider";
    else if (role === "intellectual") badgeClass += "intellectual";
    else if (role === "wildcard") badgeClass += "wildcard";
    else badgeClass += "unknown";
    header.appendChild(createEl("span", badgeClass, (c.role || "unknown").toUpperCase()));

    // Model variant label — from archetype or personality key
    var personality = c.personality;
    if (typeof personality === "string") { try { personality = JSON.parse(personality); } catch (_) { personality = null; } }
    var modelKey = "";
    if (personality && typeof personality === "object" && personality.archetype_key) {
      modelKey = personality.archetype_key;
    } else if (c.archetype) {
      modelKey = c.archetype;
    } else {
      modelKey = (c.sex || "?") + "_" + role;
    }
    var variantSuffix = c.internal_name ? " (" + c.internal_name + ")" : "";
    header.appendChild(createEl("span", "model-variant", modelKey + variantSuffix));

    // Status indicator
    var st = c.status || "idle";
    header.appendChild(createEl("span", "citizen-status-badge " + st, st));

    // Expand/collapse arrow
    header.appendChild(createEl("span", "citizen-expand-icon", "\u25BC"));

    // Click to expand/collapse
    header.addEventListener("click", function () {
      citizenExpandState[cid] = !citizenExpandState[cid];
      card.classList.toggle("expanded");
    });

    card.appendChild(header);

    // ---- EXPANDABLE BODY ----
    var body = createEl("div", "citizen-body");

    // Mini-tab bar
    var tabNames = ["Status", "Vocabulary", "Relationships", "Memory"];
    var tabKeys = ["status", "vocabulary", "relationships", "memory"];
    var activeTab = citizenTabState[cid] || "status";

    var tabBar = createEl("div", "citizen-tabs");
    var tabPanels = [];

    tabKeys.forEach(function (key, idx) {
      var btn = createEl("button", "citizen-tab" + (key === activeTab ? " active" : ""), tabNames[idx]);
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        citizenTabState[cid] = key;
        // Toggle active states
        tabBar.querySelectorAll(".citizen-tab").forEach(function (b, bi) {
          b.classList.toggle("active", bi === idx);
        });
        tabPanels.forEach(function (p, pi) {
          p.classList.toggle("active", pi === idx);
        });
      });
      tabBar.appendChild(btn);
    });
    body.appendChild(tabBar);

    // ---- TAB 1: STATUS ----
    var statusPanel = createEl("div", "citizen-tab-content" + (activeTab === "status" ? " active" : ""));
    tabPanels.push(statusPanel);

    // Vitals bars
    var bars = createEl("div", "citizen-bars");

    // Mood bar (-1 to +1)
    bars.appendChild(buildBar("Mood", ((c.mood || 0) >= 0 ? "+" : "") + (c.mood || 0).toFixed(2), ((((c.mood || 0) + 1) / 2) * 100), "mood"));

    // Energy bar (0-1)
    var energyPct = (c.energy || 0) * 100;
    bars.appendChild(buildBar("Energy", energyPct.toFixed(0) + "%", energyPct, "energy"));

    // Hunger bar (if available)
    if (c.hunger != null) {
      var hungerPct = parseFloat(c.hunger) > 1 ? parseFloat(c.hunger) : parseFloat(c.hunger) * 100;
      bars.appendChild(buildBar("Hunger", hungerPct.toFixed(0) + "%", hungerPct, "hunger"));
    }

    // Thirst bar (if available)
    if (c.thirst != null) {
      var thirstPct = parseFloat(c.thirst) > 1 ? parseFloat(c.thirst) : parseFloat(c.thirst) * 100;
      bars.appendChild(buildBar("Thirst", thirstPct.toFixed(0) + "%", thirstPct, "thirst"));
    }

    // Health bar (if available)
    if (c.health != null) {
      var healthPct = parseFloat(c.health) > 1 ? parseFloat(c.health) : parseFloat(c.health) * 100;
      bars.appendChild(buildBar("Health", healthPct.toFixed(0) + "%", healthPct, "health"));
    }

    statusPanel.appendChild(bars);

    // Change 7: Character dossier / bio line
    safe("citizen/bio", function() {
      var bioDiv = createEl("div", "citizen-bio");
      var survivalTick = c.age || 0;
      var myRelsAll = (state.relationships || []).filter(function(r) { return r.citizen_a === c.id || r.citizen_b === c.id; });
      var wordsKnown = ((state.lexicon_by_citizen && state.lexicon_by_citizen[c.id]) || []).length;
      var line1 = document.createElement("div");
      var makeStrong = function(txt) { var s = createEl("strong", null, String(txt)); return s; };
      line1.appendChild(document.createTextNode("Survived "));
      line1.appendChild(makeStrong(survivalTick));
      line1.appendChild(document.createTextNode(" ticks \u00B7 "));
      line1.appendChild(makeStrong(myRelsAll.length));
      line1.appendChild(document.createTextNode(" relationship" + (myRelsAll.length !== 1 ? "s" : "") + " \u00B7 "));
      line1.appendChild(makeStrong(wordsKnown));
      line1.appendChild(document.createTextNode(" word" + (wordsKnown !== 1 ? "s" : "") + " known \u00B7 " + (c.role || "citizen")));
      bioDiv.appendChild(line1);
      if (c.birth_tick && c.birth_tick !== 0) {
        var line2 = document.createElement("div");
        line2.appendChild(document.createTextNode("Born "));
        line2.appendChild(makeStrong("T" + c.birth_tick));
        bioDiv.appendChild(line2);
      }
      if (myRelsAll.length > 0) {
        var topRel = myRelsAll.slice().sort(function(a, b) { return Math.abs(b.score) - Math.abs(a.score); })[0];
        var otherId = topRel.citizen_a === c.id ? topRel.citizen_b : topRel.citizen_a;
        var line3 = document.createElement("div");
        var closeStrong = createEl("strong", null, findCitizenName(otherId));
        line3.appendChild(document.createTextNode("Closest: "));
        line3.appendChild(closeStrong);
        line3.appendChild(document.createTextNode(" (" + (topRel.type || "neutral") + ")"));
        bioDiv.appendChild(line3);
      }
      statusPanel.appendChild(bioDiv);
    });

    // Location
    var locText = "(" + Math.round(c.x || 0) + ", " + Math.round(c.y || 0) + ")";
    if (c.home_landmark) locText += " near " + (c.home_landmark || "").replace(/_/g, " ");
    statusPanel.appendChild(createEl("div", "citizen-location", "Location: " + locText));

    // Current speech bubble
    if (c.current_speech) {
      var speechDiv = createEl("div", "citizen-speech");
      if (c.speaking_to) {
        speechDiv.appendChild(createEl("div", "citizen-speech-to", "Speaking to " + findCitizenName(c.speaking_to)));
      }
      speechDiv.appendChild(createEl("div", "citizen-speech-text", c.current_speech));
      statusPanel.appendChild(speechDiv);
    }

    body.appendChild(statusPanel);

    // ---- TAB 2: VOCABULARY ----
    var vocabPanel = createEl("div", "citizen-tab-content" + (activeTab === "vocabulary" ? " active" : ""));
    tabPanels.push(vocabPanel);

    var vocab = (state.lexicon_by_citizen && state.lexicon_by_citizen[c.id]) || [];

    vocabPanel.appendChild(createEl("p", "explain-text", "These are sounds this citizen has learned through interaction."));
    vocabPanel.appendChild(createEl("div", "vocab-count-summary", vocab.length + " sound" + (vocab.length !== 1 ? "s" : "") + " known"));

    if (vocab.length > 0) {
      var dictList = createEl("div", "personal-dict");
      vocab.slice(0, 30).forEach(function (v) {
        var entry = createEl("div", "dict-entry");
        if (hasVoiceClip(v.sound)) {
          entry.appendChild(createPlayBtn(v.sound));
        }
        entry.appendChild(createEl("span", "dict-entry-sound", v.sound));
        entry.appendChild(createEl("span", "dict-entry-meaning", v.meaning));
        var confBar = createEl("div", "dict-entry-conf");
        var confFill = createEl("div", "dict-entry-conf-fill");
        var pct = (v.confidence * 100);
        confFill.style.width = pct + "%";
        confFill.style.background = pct > 70 ? "#4a9e6e" : pct > 40 ? "#d4a574" : "#c44a20";
        confBar.appendChild(confFill);
        entry.appendChild(confBar);
        entry.appendChild(createEl("span", "dict-entry-uses", "x" + (v.times_used || 0)));
        dictList.appendChild(entry);
      });
      if (vocab.length > 30) {
        dictList.appendChild(createEl("div", "muted-text", "+" + (vocab.length - 30) + " more..."));
      }
      vocabPanel.appendChild(dictList);
    } else {
      vocabPanel.appendChild(createEl("div", "citizen-no-data", "No sounds learned yet."));
    }

    body.appendChild(vocabPanel);

    // ---- TAB 3: RELATIONSHIPS ----
    var relPanel = createEl("div", "citizen-tab-content" + (activeTab === "relationships" ? " active" : ""));
    tabPanels.push(relPanel);

    relPanel.appendChild(createEl("p", "explain-text", "Relationship scores change based on interaction quality and shared vocabulary."));

    var allRels = state.relationships || [];
    var myRels = allRels.filter(function (r) { return r.citizen_a === c.id || r.citizen_b === c.id; });
    myRels.sort(function (a, b) { return Math.abs(b.score) - Math.abs(a.score); });
    myRels = myRels.slice(0, 5);

    if (myRels.length > 0) {
      var relList = createEl("div", "citizen-rel-list");
      myRels.forEach(function (r) {
        var otherId = r.citizen_a === c.id ? r.citizen_b : r.citizen_a;
        var row = createEl("div", "citizen-rel-row");
        row.appendChild(createEl("span", "citizen-rel-name", findCitizenName(otherId)));

        var bar = createEl("div", "citizen-rel-bar");
        var fill = createEl("div", "citizen-rel-fill " + (r.type || "neutral"));
        fill.style.width = (Math.abs(r.score) * 100) + "%";
        bar.appendChild(fill);
        row.appendChild(bar);

        row.appendChild(createEl("span", "citizen-rel-score", (r.score >= 0 ? "+" : "") + r.score.toFixed(2)));
        row.appendChild(createEl("span", "citizen-rel-type", r.type || "neutral"));
        relList.appendChild(row);
      });
      relPanel.appendChild(relList);
    } else {
      relPanel.appendChild(createEl("div", "citizen-no-data", "No relationships established yet."));
    }

    body.appendChild(relPanel);

    // ---- TAB 4: MEMORY ----
    var memPanel = createEl("div", "citizen-tab-content" + (activeTab === "memory" ? " active" : ""));
    tabPanels.push(memPanel);

    memPanel.appendChild(createEl("p", "explain-text", "Recent experiences stored in this citizen's memory buffer."));

    var memories = (state.memories_by_citizen && state.memories_by_citizen[c.id]) || [];
    if (memories.length > 0) {
      var memList = createEl("div", "memory-timeline");
      memories.slice(0, 10).forEach(function (m) {
        var item = createEl("div", "memory-item");
        item.appendChild(createEl("span", "memory-tick", "T" + m.tick));
        item.appendChild(createEl("span", "memory-event", m.event));
        memList.appendChild(item);
      });
      memPanel.appendChild(memList);
    } else {
      memPanel.appendChild(createEl("div", "citizen-no-data", "No memories recorded yet."));
    }

    body.appendChild(memPanel);

    // Action buttons row
    var actions = createEl("div", "citizen-actions");
    actions.style.display = "flex";
    actions.style.gap = "6px";
    actions.style.padding = "8px 0 4px";
    actions.style.borderTop = "1px solid rgba(30,30,42,0.3)";

    var inspectBtn = createEl("button", "citizen-action-btn", "Inspect");
    inspectBtn.addEventListener("click", function(e) { e.stopPropagation(); openInspectPanel(cid); });
    actions.appendChild(inspectBtn);

    var compareBtn = createEl("button", "citizen-action-btn", "Compare");
    compareBtn.addEventListener("click", function(e) { e.stopPropagation(); addToCompare(cid); });
    actions.appendChild(compareBtn);

    body.appendChild(actions);

    card.appendChild(body);
    return card;
  }

  // Helper: build a vitals bar row (label + track)
  function buildBar(name, valText, pct, cssClass) {
    var group = createEl("div", "bar-group");
    var label = createEl("div", "bar-label");
    label.appendChild(createEl("span", "bar-label-name", name));
    label.appendChild(createEl("span", "bar-label-val", valText));
    group.appendChild(label);
    var track = createEl("div", "bar-track");
    var fill = createEl("div", "bar-fill " + cssClass);
    fill.style.width = Math.min(100, Math.max(0, pct)).toFixed(0) + "%";
    track.appendChild(fill);
    group.appendChild(track);
    return group;
  }

  function addStat(container, label, value) {
    var stat = createEl("span", "citizen-stat");
    stat.appendChild(createEl("span", "citizen-stat-label", label + ": "));
    stat.appendChild(createEl("span", "citizen-stat-value", value));
    container.appendChild(stat);
  }

  // ---------------------------------------------------------------------------
  // TAB 3: Language
  // ---------------------------------------------------------------------------

  function renderLanguageTab() {
    var ustats = state.utterance_stats || {};

    // Overview numbers
    var totalSounds = 0;
    var lexByCitizen = state.lexicon_by_citizen || {};
    var allSounds = new Set();
    for (var cid in lexByCitizen) {
      (lexByCitizen[cid] || []).forEach(function (v) { allSounds.add(v.sound); });
    }
    totalSounds = allSounds.size;

    setText("lang-total-sounds", String(totalSounds));
    setText("lang-shared-words", String(state.shared_lexicon ? state.shared_lexicon.length : 0));
    setText("lang-active-speakers", String(ustats.active_speakers || 0));
    setText("lang-total-utterances", formatNumber(ustats.total_utterances || 0));

    // Charts
    drawLineChart("chart-success-rate", history.success_rate, "#4a9e6e", "%", "Communication Success Rate");
    drawLineChart("chart-vocab-growth", history.vocab_size, "#d4a574", "", "Shared Vocabulary Size");

    // Shared dictionary
    renderSharedDictionary();

    // Per-citizen vocab bars
    renderVocabComparison();

    // Recent transfers
    renderTransfersTable();
  }

  function renderSharedDictionary() {
    var body = byId("shared-dict-body");
    if (!body) return;
    clearEl(body);

    var shared = (state.shared_lexicon || []).slice();

    // Filter
    if (dictSearchTerm) {
      shared = shared.filter(function (s) {
        return s.sound.toLowerCase().indexOf(dictSearchTerm) !== -1 ||
               s.meaning.toLowerCase().indexOf(dictSearchTerm) !== -1;
      });
    }

    // Sort
    shared.sort(function (a, b) {
      switch (dictSortKey) {
        case "sound": return a.sound.localeCompare(b.sound);
        case "meaning": return a.meaning.localeCompare(b.meaning);
        case "citizens": return (b.citizen_count || 0) - (a.citizen_count || 0);
        case "tick": return (a.tick_established || 0) - (b.tick_established || 0);
        default: return b.confidence - a.confidence;
      }
    });

    if (shared.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.style.cssText = "color:var(--text-muted);text-align:center;padding:20px";
      td.textContent = dictSearchTerm ? "No matches found" : "No shared language yet";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    shared.forEach(function (s) {
      var tr = document.createElement("tr");

      // Sound (with play button if audio available)
      var tdSound = document.createElement("td");
      tdSound.className = "sound-cell";
      tdSound.style.display = "flex";
      tdSound.style.alignItems = "center";
      tdSound.style.gap = "6px";
      if (hasVoiceClip(s.sound)) {
        tdSound.appendChild(createPlayBtn(s.sound));
      }
      tdSound.appendChild(document.createTextNode(s.sound));
      tr.appendChild(tdSound);

      // Meaning
      var tdMeaning = document.createElement("td");
      tdMeaning.className = "meaning-cell";
      tdMeaning.textContent = s.meaning;
      tr.appendChild(tdMeaning);

      // Confidence
      var tdConf = document.createElement("td");
      var pct = (s.confidence * 100).toFixed(0);
      var cBar = createEl("span", "confidence-bar");
      var cFill = createEl("span", "confidence-fill");
      var confClass = pct >= 70 ? "confidence-high" : pct >= 40 ? "confidence-mid" : "confidence-low";
      cFill.className = "confidence-fill " + confClass;
      cFill.style.width = pct + "%";
      cBar.appendChild(cFill);
      tdConf.appendChild(cBar);
      tdConf.appendChild(document.createTextNode(" " + pct + "%"));
      tr.appendChild(tdConf);

      // Known By (citizen dots)
      var tdCit = document.createElement("td");
      var dotsContainer = createEl("span", "citizen-dots");
      var knownByNames = [];
      if (Array.isArray(s.established_by)) {
        s.established_by.forEach(function (cid) {
          var dot = createEl("span", "citizen-dot-mini");
          dot.style.background = getCitizenSex(cid) === "female" ? "#d4a574" : "#5a9bba";
          dot.title = findCitizenName(cid);
          dotsContainer.appendChild(dot);
          knownByNames.push(findCitizenName(cid));
        });
      }
      tdCit.appendChild(dotsContainer);
      if (knownByNames.length === 0 && s.citizen_count) {
        tdCit.appendChild(document.createTextNode(" " + s.citizen_count + " citizens"));
      } else {
        tdCit.appendChild(document.createTextNode(" " + knownByNames.join(", ")));
      }
      tdCit.style.fontSize = "0.72rem";
      tdCit.style.color = "var(--text-secondary)";
      tr.appendChild(tdCit);

      // Established At
      var tdTick = document.createElement("td");
      tdTick.style.cssText = "font-family:var(--font-mono);font-size:0.72rem;color:var(--text-muted)";
      tdTick.textContent = s.tick_established != null ? "T" + s.tick_established : "--";
      tr.appendChild(tdTick);

      body.appendChild(tr);
    });
  }

  function renderVocabComparison() {
    var container = byId("vocab-comparison-bars");
    if (!container) return;
    clearEl(container);

    var citizens = getCitizens();
    var lexByCitizen = state.lexicon_by_citizen || {};

    // Build data and find max
    var data = citizens.map(function (c) {
      return { name: c.name, id: c.id, count: (lexByCitizen[c.id] || []).length };
    });
    data.sort(function (a, b) { return b.count - a.count; });
    var maxCount = data.reduce(function (m, d) { return Math.max(m, d.count); }, 1);

    data.forEach(function (d) {
      var row = createEl("div", "vocab-bar-row");
      row.appendChild(createEl("span", "vocab-bar-name", d.name));
      var track = createEl("div", "vocab-bar-track");
      var fill = createEl("div", "vocab-bar-fill");
      fill.style.width = ((d.count / maxCount) * 100) + "%";
      fill.style.background = getCitizenColor(d.id);
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(createEl("span", "vocab-bar-count", String(d.count)));
      container.appendChild(row);
    });
  }

  function renderTransfersTable() {
    var body = byId("transfers-body");
    if (!body) return;
    clearEl(body);

    var utterances = state.recent_utterances || [];
    if (utterances.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.style.cssText = "color:var(--text-muted);text-align:center;padding:20px";
      td.textContent = "No utterances recorded yet";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    utterances.forEach(function (u) {
      var tr = document.createElement("tr");

      var tdT = document.createElement("td");
      tdT.style.cssText = "font-family:var(--font-mono);font-size:0.72rem";
      tdT.textContent = "T" + u.tick;
      tr.appendChild(tdT);

      var tdSpk = document.createElement("td");
      tdSpk.textContent = findCitizenName(u.citizen_id);
      tr.appendChild(tdSpk);

      var tdUtt = document.createElement("td");
      tdUtt.className = "sound-cell";
      tdUtt.textContent = u.utterance;
      tr.appendChild(tdUtt);

      var tdUnd = document.createElement("td");
      tdUnd.style.color = "var(--text-secondary)";
      tdUnd.textContent = u.understood_by ? findCitizenName(u.understood_by) : "--";
      tr.appendChild(tdUnd);

      var tdSuc = document.createElement("td");
      tdSuc.textContent = u.success ? "Yes" : "No";
      tdSuc.style.color = u.success ? "var(--accent-green)" : "var(--text-muted)";
      tdSuc.style.fontWeight = u.success ? "600" : "400";
      tr.appendChild(tdSuc);

      body.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------------
  // TAB 4: Events
  // ---------------------------------------------------------------------------

  function renderEventsTimeline() {
    var container = byId("events-timeline");
    if (!container) return;
    clearEl(container);

    // Merge world events and interactions
    var events = [];

    (state.world_events || []).forEach(function (e) {
      events.push({
        tick: e.tick,
        type: e.event_type || "world",
        description: e.description,
        affected: e.affected_citizens || [],
        speech: null,
        timestamp: e.timestamp
      });
    });

    (state.interactions || []).forEach(function (i) {
      events.push({
        tick: i.tick,
        type: "interaction",
        description: findCitizenName(i.citizen_a) + " \u2194 " + findCitizenName(i.citizen_b),
        affected: [i.citizen_a, i.citizen_b],
        speech_a: i.speech_a,
        speech_b: i.speech_b,
        summary: i.summary,
        timestamp: i.timestamp
      });
    });

    (state.milestones || []).forEach(function (m) {
      events.push({
        tick: m.tick,
        type: "milestone",
        description: m.milestone + ": " + (m.description || ""),
        affected: [],
        timestamp: m.timestamp
      });
    });

    // Sort newest first
    events.sort(function (a, b) { return (b.timestamp || b.tick) - (a.timestamp || a.tick); });

    // Filter
    if (activeEventFilter !== "all") {
      events = events.filter(function (e) {
        if (activeEventFilter === "milestone") return e.type === "milestone";
        return e.type.toLowerCase().indexOf(activeEventFilter) !== -1;
      });
    }

    if (events.length === 0) {
      container.appendChild(createEl("div", "muted-text", "No events match this filter."));
      return;
    }

    events.slice(0, 100).forEach(function (e) {
      var card = createEl("div", "event-card");

      // Tick column
      var tickCol = createEl("div", "event-tick-col");
      tickCol.appendChild(createEl("div", "event-tick-num", "T" + e.tick));
      var badgeClass = "event-type-badge " + (e.type || "world");
      tickCol.appendChild(createEl("div", badgeClass, e.type || "event"));
      card.appendChild(tickCol);

      // Body
      var body = createEl("div", "event-body");
      body.appendChild(createEl("div", "event-description", e.description));

      if (e.speech_a) {
        body.appendChild(createEl("div", "event-speech", "\u201C" + e.speech_a + "\u201D"));
      }
      if (e.speech_b) {
        body.appendChild(createEl("div", "event-speech", "\u201C" + e.speech_b + "\u201D"));
      }
      if (e.summary) {
        body.appendChild(createEl("div", "feed-summary", e.summary));
      }

      // Affected citizens
      if (e.affected && e.affected.length > 0) {
        var affectedDiv = createEl("div", "event-affected");
        e.affected.forEach(function (cid) {
          var tag = createEl("span", "event-citizen-tag");
          var dot = createEl("span", "citizen-dot-mini");
          dot.style.background = getCitizenSex(cid) === "female" ? "#d4a574" : "#5a9bba";
          tag.appendChild(dot);
          tag.appendChild(document.createTextNode(" " + findCitizenName(cid)));
          affectedDiv.appendChild(tag);
        });
        body.appendChild(affectedDiv);
      }

      card.appendChild(body);
      container.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------------
  // TAB 5: Learning
  // ---------------------------------------------------------------------------

  function renderLearningTab() {
    // Populate hero metrics from live data
    safe("learning/hero", function() {
      var worlds = state.worlds || [];
      var deaths = state.deaths || [];
      setText("lh-worlds", worlds.length || "--");
      setText("lh-interactions", state.total_interactions || "--");
      setText("lh-deaths", deaths.length || "--");
      setText("lh-vocab", state.shared_lexicon ? state.shared_lexicon.length : "--");
    });

    var charts = [
      ["sciMetrics", renderSciMetricsDashboard],
      ["heapsLaw", drawHeapsLawChart],
      ["zipfGauge", drawZipfGauge],
      ["growthCurve", drawGrowthCurveChart],
      ["networkAnalysis", drawNetworkAnalysisChart],
      ["influence", drawInfluenceChart],
      ["cascades", renderCascadeCards],
      ["commEfficiency", drawCommEfficiencyChart],
      ["contextDonut", drawContextDonutChart],
      ["heatmap", drawInteractionHeatmap],
      ["milestoneTimeline", drawMilestoneTimeline],
      ["deathStats", drawDeathStatsChart],
      ["worldComparison", drawWorldComparisonChart],
      ["snapshotTimeline", drawSnapshotTimeline],
      ["heapsHistory", drawHeapsHistory],
      ["zipfHistory", drawZipfHistory],
      ["trainingHistory", drawTrainingHistory],
      ["trainingTable", renderTrainingRunsTable],
      ["milestones", renderMilestones],
      ["citizenVocab", drawCitizenVocabChart],
      ["citizenSuccess", renderCitizenSuccessBars],
      ["intelligenceStats", renderIntelligenceStats],
      // Extended charts
      ["semanticFields", drawSemanticFieldChart],
      ["phonemeFreq", drawPhonemeFreqChart],
      ["archetypeCompare", drawArchetypeCompare],
      ["relTypes", drawRelTypesChart],
      ["survivalCurves", drawSurvivalCurves],
      ["eventFreq", drawEventFreqChart],
      ["moodHeatmap", drawMoodHeatmap],
      ["vocabOverlap", drawVocabOverlap],
      ["transferNetwork", drawTransferNetwork],
      ["worldOverlay", drawWorldOverlay],
      ["worldLeaderboard", renderWorldLeaderboard],
      ["etymology", renderEtymology],
      ["predationTimeline", drawPredationTimeline],
    ];
    charts.forEach(function (c) {
      safe("learning/" + c[0], c[1]);
    });
  }

  // --- Historical Snapshot Timeline ---
  function drawSnapshotTimeline() {
    var r = setupCanvas("chart-snapshot-timeline");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var snaps = state.snapshots || [];
    if (snaps.length < 2) { drawNoData(ctx, w, h, "Accumulating snapshots (saved every 50 ticks)..."); return; }

    var pad = { top: 25, bottom: 35, left: 50, right: 50 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    var minTick = snaps[0].tick, maxTick = snaps[snaps.length - 1].tick;
    if (maxTick === minTick) maxTick = minTick + 1;

    // Find max values for 3 series
    var maxAlive = 0, maxVocab = 0;
    snaps.forEach(function (s) {
      if (s.alive_count > maxAlive) maxAlive = s.alive_count;
      if (s.shared_vocab_size > maxVocab) maxVocab = s.shared_vocab_size;
    });
    if (maxAlive === 0) maxAlive = 1;
    if (maxVocab === 0) maxVocab = 1;

    // Grid
    ctx.strokeStyle = "rgba(30,30,42,0.5)";
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.top + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    }

    // Population line (blue, left axis)
    ctx.strokeStyle = "#5a9bba"; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.beginPath();
    snaps.forEach(function (s, i) {
      var x = pad.left + ((s.tick - minTick) / (maxTick - minTick)) * cw;
      var y = pad.top + ch - (s.alive_count / maxAlive) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Shared vocab line (green)
    ctx.strokeStyle = "#4a9e6e"; ctx.lineWidth = 2;
    ctx.beginPath();
    snaps.forEach(function (s, i) {
      var x = pad.left + ((s.tick - minTick) / (maxTick - minTick)) * cw;
      var y = pad.top + ch - (s.shared_vocab_size / maxVocab) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Success rate line (amber, 0-100%)
    ctx.strokeStyle = "#d4a574"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    snaps.forEach(function (s, i) {
      var x = pad.left + ((s.tick - minTick) / (maxTick - minTick)) * cw;
      var y = pad.top + ch - (s.communication_success_rate || 0) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Left axis (population)
    ctx.fillStyle = "#5a9bba"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
    for (var li = 0; li <= 4; li++) {
      ctx.fillText(Math.round((li / 4) * maxAlive), pad.left - 4, pad.top + ch - (li / 4) * ch + 3);
    }

    // Right axis (vocab)
    ctx.fillStyle = "#4a9e6e"; ctx.textAlign = "left";
    for (var ri = 0; ri <= 4; ri++) {
      ctx.fillText(Math.round((ri / 4) * maxVocab), w - pad.right + 4, pad.top + ch - (ri / 4) * ch + 3);
    }

    // Stage markers
    var prevStage = "";
    snaps.forEach(function (s) {
      if (s.stage && s.stage !== prevStage) {
        var x = pad.left + ((s.tick - minTick) / (maxTick - minTick)) * cw;
        ctx.strokeStyle = "rgba(212,165,116,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(212,165,116,0.5)"; ctx.font = "8px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
        ctx.fillText(s.stage.replace(/-/g, " "), x, pad.top - 4);
        prevStage = s.stage;
      }
    });

    // Legend
    var legendY = pad.top + 4;
    ctx.fillStyle = "#5a9bba"; ctx.fillRect(pad.left, legendY, 12, 3);
    ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Population", pad.left + 16, legendY + 4);
    ctx.fillStyle = "#4a9e6e"; ctx.fillRect(pad.left + 95, legendY, 12, 3);
    ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.fillText("Shared Vocab", pad.left + 111, legendY + 4);
    ctx.fillStyle = "#d4a574"; ctx.setLineDash([4, 3]); ctx.strokeStyle = "#d4a574"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pad.left + 200, legendY + 1); ctx.lineTo(pad.left + 212, legendY + 1); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.fillText("Success %", pad.left + 216, legendY + 4);

    // X axis
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Tick (" + snaps.length + " snapshots)", w / 2, h - 5);
  }

  // --- Heaps' Beta Over Time ---
  function drawHeapsHistory() {
    var r = setupCanvas("chart-heaps-history");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sh = state.science_history || [];
    var pts = [];
    sh.forEach(function (s) {
      if (s.metrics && s.metrics.heaps && s.metrics.heaps.heaps_beta != null) {
        pts.push({ tick: s.tick, val: s.metrics.heaps.heaps_beta });
      }
    });
    if (pts.length < 2) { drawNoData(ctx, w, h, "Accumulating Heaps' history..."); return; }

    var pad = { top: 20, bottom: 30, left: 45, right: 15 };
    var cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var minT = pts[0].tick, maxT = pts[pts.length - 1].tick;
    if (maxT === minT) maxT = minT + 1;

    // Natural language band
    ctx.fillStyle = "rgba(74,158,110,0.08)";
    var bandTop = pad.top + ch - (0.6 / 1.2) * ch;
    var bandBot = pad.top + ch - (0.4 / 1.2) * ch;
    ctx.fillRect(pad.left, bandTop, cw, bandBot - bandTop);
    ctx.fillStyle = "rgba(74,158,110,0.4)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Natural range 0.4-0.6", pad.left + 4, bandTop + 10);

    // Grid
    ctx.strokeStyle = "rgba(30,30,42,0.5)"; ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.top + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
      ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
      ctx.fillText((gi / 4 * 1.2).toFixed(1), pad.left - 4, gy + 3);
    }

    // Line
    ctx.strokeStyle = "#d4a574"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    pts.forEach(function (p, i) {
      var x = pad.left + ((p.tick - minT) / (maxT - minT)) * cw;
      var y = pad.top + ch - (Math.min(p.val, 1.2) / 1.2) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Current value
    var last = pts[pts.length - 1];
    ctx.fillStyle = "#d4a574"; ctx.font = "bold 11px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
    ctx.fillText("\u03B2 = " + last.val.toFixed(3), w - pad.right, pad.top + 12);

    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Tick", w / 2, h - 5);
  }

  // --- Zipf Coefficient Over Time ---
  function drawZipfHistory() {
    var r = setupCanvas("chart-zipf-history");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sh = state.science_history || [];
    var pts = [];
    sh.forEach(function (s) {
      if (s.metrics && s.metrics.zipf && s.metrics.zipf.zipf_coefficient != null) {
        pts.push({ tick: s.tick, val: s.metrics.zipf.zipf_coefficient });
      }
    });
    if (pts.length < 2) { drawNoData(ctx, w, h, "Accumulating Zipf history..."); return; }

    var pad = { top: 20, bottom: 30, left: 45, right: 15 };
    var cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var minT = pts[0].tick, maxT = pts[pts.length - 1].tick;
    if (maxT === minT) maxT = minT + 1;

    // Target line at -1.0
    var targetY = pad.top + ch - (1.0 / 1.5) * ch;
    ctx.strokeStyle = "rgba(74,158,110,0.4)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, targetY); ctx.lineTo(w - pad.right, targetY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(74,158,110,0.5)"; ctx.font = "8px 'JetBrains Mono', monospace"; ctx.textAlign = "left";
    ctx.fillText("Target: -1.00", pad.left + 4, targetY - 4);

    // Grid
    ctx.strokeStyle = "rgba(30,30,42,0.5)"; ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.top + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
      ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
      ctx.fillText("-" + (gi / 4 * 1.5).toFixed(1), pad.left - 4, gy + 3);
    }

    // Line
    ctx.strokeStyle = "#5a9bba"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    pts.forEach(function (p, i) {
      var x = pad.left + ((p.tick - minT) / (maxT - minT)) * cw;
      var y = pad.top + ch - (Math.min(Math.abs(p.val), 1.5) / 1.5) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    var last = pts[pts.length - 1];
    ctx.fillStyle = "#5a9bba"; ctx.font = "bold 11px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
    ctx.fillText("coeff = " + last.val.toFixed(3), w - pad.right, pad.top + 12);

    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Tick", w / 2, h - 5);
  }

  // --- Training History Chart ---
  function drawTrainingHistory() {
    var r = setupCanvas("chart-training-history");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var runs = state.training_runs || [];
    if (runs.length === 0) { drawNoData(ctx, w, h, "No training runs recorded yet"); return; }

    var citizens = getCitizens();
    var nameMap = {};
    citizens.forEach(function (c) { nameMap[c.id] = c.name; });

    // Group by citizen
    var byCitizen = {};
    runs.forEach(function (run) {
      if (!byCitizen[run.citizen_id]) byCitizen[run.citizen_id] = [];
      byCitizen[run.citizen_id].push(run);
    });

    var citizenIds = Object.keys(byCitizen);
    var maxVersion = 0;
    citizenIds.forEach(function (cid) {
      byCitizen[cid].forEach(function (run) {
        if (run.version > maxVersion) maxVersion = run.version;
      });
    });
    if (maxVersion === 0) maxVersion = 1;

    var pad = { top: 15, bottom: 35, left: 80, right: 15 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;
    var rowH = Math.max(14, Math.min(24, ch / citizenIds.length - 2));

    // Column: one per version
    var colW = cw / maxVersion;

    // Header
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "8px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
    for (var vi = 1; vi <= maxVersion; vi++) {
      ctx.fillText("v" + vi, pad.left + (vi - 0.5) * colW, pad.top - 3);
    }

    // Rows per citizen
    var catColors = { base: "#5a9bba", real: "#4a9e6e", vocab: "#d4a574", gesture: "#8a6abf" };
    citizenIds.forEach(function (cid, ci) {
      var y = pad.top + ci * (rowH + 2);
      var name = nameMap[cid] || cid.substring(0, 8);

      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "right";
      ctx.fillText(name, pad.left - 6, y + rowH / 2 + 3);

      byCitizen[cid].forEach(function (run) {
        var x = pad.left + (run.version - 1) * colW;
        var total = run.total_examples || 1;
        var segments = [
          { val: run.base_examples || 0, color: catColors.base },
          { val: run.real_examples || 0, color: catColors.real },
          { val: run.vocab_reinforcement || 0, color: catColors.vocab },
          { val: run.gesture_grounding || 0, color: catColors.gesture },
        ];
        var sx = x + 2;
        segments.forEach(function (seg) {
          var sw = (seg.val / total) * (colW - 4);
          if (sw > 0.5) {
            ctx.fillStyle = seg.color;
            ctx.fillRect(sx, y, sw, rowH);
            sx += sw;
          }
        });
      });
    });

    // Legend
    var ly = h - 18;
    var items = [
      { label: "Base", color: catColors.base },
      { label: "Real Interactions", color: catColors.real },
      { label: "Vocab Reinforcement", color: catColors.vocab },
      { label: "Gesture Grounding", color: catColors.gesture },
    ];
    var lx = pad.left;
    items.forEach(function (item) {
      ctx.fillStyle = item.color; ctx.fillRect(lx, ly, 10, 10);
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "left";
      ctx.fillText(item.label, lx + 14, ly + 9);
      lx += ctx.measureText(item.label).width + 28;
    });
  }

  // --- Training Runs Table (DOM-based) ---
  function renderTrainingRunsTable() {
    var container = byId("training-runs-table");
    if (!container) return;
    clearEl(container);
    var runs = state.training_runs || [];
    if (runs.length === 0) {
      container.appendChild(createEl("span", "muted-text", "No training runs recorded yet"));
      return;
    }

    var citizens = getCitizens();
    var nameMap = {};
    citizens.forEach(function (c) { nameMap[c.id] = c.name; });

    var table = createEl("table", "dict-table");
    table.style.width = "100%";
    var thead = createEl("thead");
    var headRow = createEl("tr");
    ["Citizen", "Version", "Base", "Real", "Vocab", "Gesture", "Total", "Ticks"].forEach(function (h) {
      var th = createEl("th"); th.textContent = h; headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = createEl("tbody");
    runs.slice().reverse().forEach(function (run) {
      var tr = createEl("tr");
      var name = nameMap[run.citizen_id] || run.citizen_id.substring(0, 8);
      var cells = [
        name,
        "v" + run.version,
        formatNumber(run.base_examples || 0),
        formatNumber(run.real_examples || 0),
        formatNumber(run.vocab_reinforcement || 0),
        formatNumber(run.gesture_grounding || 0),
        formatNumber(run.total_examples || 0),
        (run.since_tick || 0) + " - " + (run.through_tick || 0),
      ];
      cells.forEach(function (val) {
        var td = createEl("td"); td.textContent = val; tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  // --- Science Metrics Dashboard (6 big number cards) ---
  function renderSciMetricsDashboard() {
    var sci = state.science || {};
    function setCard(id, value, sub) {
      var card = byId(id);
      if (!card) return;
      var valEl = card.querySelector(".sci-metric-value");
      var subEl = card.querySelector(".sci-metric-sub");
      if (valEl) valEl.textContent = value;
      if (subEl) subEl.textContent = sub || "";
    }
    var heaps = sci.heaps || {};
    var zipf = sci.zipf || {};
    var net = sci.network || {};
    var infl = sci.influence || {};
    var gc = sci.growth_curve || {};
    var eff = sci.efficiency || {};

    setCard("sci-heaps-beta",
      heaps.heaps_beta != null ? heaps.heaps_beta.toFixed(2) : "--",
      heaps.r_squared != null ? "R\u00B2 = " + heaps.r_squared.toFixed(3) : "");
    setCard("sci-zipf-coeff",
      zipf.zipf_coefficient != null ? zipf.zipf_coefficient.toFixed(2) : "--",
      zipf.r_squared != null ? "R\u00B2 = " + zipf.r_squared.toFixed(3) : "");
    setCard("sci-clustering",
      net.clustering_coefficient != null ? net.clustering_coefficient.toFixed(3) : "--",
      net.comparison_to_random ? (net.comparison_to_random.more_structured_than_random ? "More structured than random" : "Similar to random") : "");
    setCard("sci-transfers",
      infl.total_transfer_events != null ? formatNumber(infl.total_transfer_events) : "--",
      infl.transfer_graph_edges != null ? infl.transfer_graph_edges + " edges" : "");
    var successPct = "--";
    if (eff.success_rate_over_time && eff.success_rate_over_time.length > 0) {
      var last = eff.success_rate_over_time[eff.success_rate_over_time.length - 1];
      successPct = (last.success_rate * 100).toFixed(0) + "%";
    }
    setCard("sci-efficiency", successPct, "latest success rate");
    setCard("sci-growth-model",
      gc.growth_model || "--",
      gc.r_squared != null ? "R\u00B2 = " + gc.r_squared.toFixed(3) : "");
  }

  // --- Helper: setup canvas with DPR ---
  function setupCanvas(canvasId) {
    var canvas = byId(canvasId);
    if (!canvas) {
      log(LOG_LEVEL.DEBUG, "canvas", "Canvas '" + canvasId + "' not found in DOM");
      return null;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      log(LOG_LEVEL.WARN, "canvas", "Failed to get 2d context for '" + canvasId + "'");
      return null;
    }
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var rw = rect.width || canvas.clientWidth || 400;
    var rh = canvas.height || 260;
    if (rw < 1 || rh < 1) {
      log(LOG_LEVEL.DEBUG, "canvas", "Canvas '" + canvasId + "' has zero dimensions (" + rw + "x" + rh + ")");
      return null;
    }
    canvas.width = rw * dpr;
    canvas.height = rh * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rw, rh);
    return { ctx: ctx, w: rw, h: rh, dpr: dpr };
  }

  function drawNoData(ctx, w, h, msg) {
    ctx.fillStyle = "rgba(90,84,101,0.6)";
    ctx.font = "12px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(msg || "Waiting for data...", w / 2, h / 2);
  }

  // --- Heaps' Law Chart ---
  function drawHeapsLawChart() {
    var r = setupCanvas("chart-heaps-law");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sci = state.science || {};
    var heaps = sci.heaps || {};
    var gd = heaps.growth_curve || [];
    if (gd.length < 2) { drawNoData(ctx, w, h, "Accumulating Heaps' Law data..."); return; }

    var pad = { top: 20, bottom: 35, left: 55, right: 20 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    var maxX = 0, maxY = 0;
    gd.forEach(function(p) {
      if (p.total_tokens > maxX) maxX = p.total_tokens;
      if (p.unique_tokens > maxY) maxY = p.unique_tokens;
    });
    if (maxX === 0) maxX = 1;
    if (maxY === 0) maxY = 1;
    maxY = maxY * 1.2;

    // Grid
    ctx.strokeStyle = "rgba(30,30,42,0.5)";
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var gy = pad.top + ch - (i / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
      ctx.fillStyle = "rgba(90,84,101,0.6)";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(Math.round((i / 4) * maxY), pad.left - 4, gy + 3);
    }

    // Natural language reference band (beta 0.4-0.6)
    if (heaps.heaps_K) {
      ctx.fillStyle = "rgba(74,158,110,0.08)";
      for (var bx = 0; bx < cw; bx += 2) {
        var tokens = (bx / cw) * maxX;
        var lo = heaps.heaps_K * Math.pow(Math.max(tokens, 1), 0.4);
        var hi = heaps.heaps_K * Math.pow(Math.max(tokens, 1), 0.6);
        var y1 = pad.top + ch - (Math.min(hi, maxY) / maxY) * ch;
        var y2 = pad.top + ch - (Math.min(lo, maxY) / maxY) * ch;
        ctx.fillRect(pad.left + bx, y1, 2, y2 - y1);
      }
      ctx.fillStyle = "rgba(74,158,110,0.4)";
      ctx.font = "9px 'Inter', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Natural language range (\u03B2 0.4-0.6)", pad.left + 4, pad.top + 12);
    }

    // Data points
    ctx.fillStyle = "#d4a574";
    gd.forEach(function(p) {
      var px = pad.left + (p.total_tokens / maxX) * cw;
      var py = pad.top + ch - (p.unique_tokens / maxY) * ch;
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    });

    // Fit curve
    if (heaps.heaps_K && heaps.heaps_beta) {
      ctx.strokeStyle = "#d4a574";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var fx = 0; fx <= cw; fx += 2) {
        var ft = (fx / cw) * maxX;
        var fv = heaps.heaps_K * Math.pow(Math.max(ft, 1), heaps.heaps_beta);
        var fy = pad.top + ch - (Math.min(fv, maxY) / maxY) * ch;
        if (fx === 0) ctx.moveTo(pad.left + fx, fy);
        else ctx.lineTo(pad.left + fx, fy);
      }
      ctx.stroke();
    }

    // Labels
    ctx.fillStyle = "#d4a574";
    ctx.font = "bold 11px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText("\u03B2 = " + (heaps.heaps_beta || 0).toFixed(2) + "  R\u00B2 = " + (heaps.r_squared || 0).toFixed(3), w - pad.right, pad.top + 12);

    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Total Tokens", w / 2, h - 5);
    ctx.save();
    ctx.translate(12, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Unique Types", 0, 0);
    ctx.restore();
  }

  // --- Zipf's Law Gauge ---
  function drawZipfGauge() {
    var r = setupCanvas("chart-zipf-gauge");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sci = state.science || {};
    var zipf = sci.zipf || {};
    var coeff = zipf.zipf_coefficient || 0;

    if (!coeff && coeff !== 0) { drawNoData(ctx, w, h, "Waiting for Zipf data..."); return; }

    var cx = w / 2;
    var cy = h * 0.55;
    var gaugeR = Math.min(w, h) * 0.35;

    // Gauge arc background
    var startAngle = Math.PI * 0.8;
    var endAngle = Math.PI * 2.2;
    ctx.lineWidth = 18;
    ctx.lineCap = "round";

    // Background arc
    ctx.strokeStyle = "rgba(30,30,42,0.6)";
    ctx.beginPath();
    ctx.arc(cx, cy, gaugeR, startAngle, endAngle);
    ctx.stroke();

    // Colored arc segments
    var segments = 40;
    for (var si = 0; si < segments; si++) {
      var t = si / segments;
      var a1 = startAngle + t * (endAngle - startAngle);
      var a2 = startAngle + (t + 1 / segments) * (endAngle - startAngle);
      var rr, gg, bb;
      if (t < 0.5) { rr = 196; gg = Math.round(74 + t * 2 * 168); bb = 32; }
      else { rr = Math.round(196 - (t - 0.5) * 2 * 122); gg = Math.round(242 - (t - 0.5) * 2 * 84); bb = Math.round(32 + (t - 0.5) * 2 * 78); }
      ctx.strokeStyle = "rgba(" + rr + "," + gg + "," + bb + ",0.3)";
      ctx.beginPath();
      ctx.arc(cx, cy, gaugeR, a1, a2 + 0.02);
      ctx.stroke();
    }

    // Value indicator
    var valNorm = Math.min(Math.max(Math.abs(coeff), 0), 1.5) / 1.5;
    var valAngle = startAngle + valNorm * (endAngle - startAngle);

    // Active arc up to value
    var grad = ctx.createLinearGradient(cx - gaugeR, cy, cx + gaugeR, cy);
    grad.addColorStop(0, "#c44a20");
    grad.addColorStop(0.5, "#d4a574");
    grad.addColorStop(1, "#4a9e6e");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(cx, cy, gaugeR, startAngle, valAngle);
    ctx.stroke();

    // Needle dot
    var nx = cx + gaugeR * Math.cos(valAngle);
    var ny = cy + gaugeR * Math.sin(valAngle);
    ctx.fillStyle = "#f0e0cc";
    ctx.beginPath(); ctx.arc(nx, ny, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0a0a0f";
    ctx.beginPath(); ctx.arc(nx, ny, 3, 0, Math.PI * 2); ctx.fill();

    // Center value
    ctx.fillStyle = "#f0e0cc";
    ctx.font = "bold 28px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(coeff.toFixed(2), cx, cy + 8);

    // Target label
    ctx.fillStyle = "rgba(74,158,110,0.7)";
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillText("Target: -1.00", cx, cy + 28);

    // R squared
    if (zipf.r_squared != null) {
      ctx.fillStyle = "rgba(90,84,101,0.6)";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText("R\u00B2 = " + zipf.r_squared.toFixed(3), cx, cy + 46);
    }

    // Scale labels
    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    var lbls = [{ v: "0.00", a: startAngle }, { v: "-0.50", a: startAngle + (endAngle - startAngle) / 3 }, { v: "-1.00", a: startAngle + 2 * (endAngle - startAngle) / 3 }, { v: "-1.50", a: endAngle }];
    lbls.forEach(function(l) {
      var lx = cx + (gaugeR + 20) * Math.cos(l.a);
      var ly = cy + (gaugeR + 20) * Math.sin(l.a);
      ctx.fillText(l.v, lx, ly);
    });
  }

  // --- Growth Curve ---
  function drawGrowthCurveChart() {
    var r = setupCanvas("chart-growth-curve");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sci = state.science || {};
    var gc = sci.growth_curve || {};
    var gd = gc.growth_data || gc.data_points || [];
    if (gd.length < 2) { drawNoData(ctx, w, h, "Accumulating growth data..."); return; }

    var pad = { top: 15, bottom: 30, left: 45, right: 15 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    var maxTick = 0, maxVocab = 0;
    gd.forEach(function(p) {
      if (p.tick > maxTick) maxTick = p.tick;
      if (p.vocab_size > maxVocab) maxVocab = p.vocab_size;
    });
    if (maxTick === 0) maxTick = 1;
    maxVocab = maxVocab * 1.2 || 1;

    // Grid
    ctx.strokeStyle = "rgba(30,30,42,0.5)";
    ctx.lineWidth = 1;
    for (var yi = 0; yi <= 4; yi++) {
      var gy = pad.top + ch - (yi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
      ctx.fillStyle = "rgba(90,84,101,0.6)";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(Math.round((yi / 4) * maxVocab), pad.left - 4, gy + 3);
    }

    // Data line
    ctx.strokeStyle = "#4a9e6e";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    gd.forEach(function(p, idx) {
      var x = pad.left + (p.tick / maxTick) * cw;
      var y = pad.top + ch - (p.vocab_size / maxVocab) * ch;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Area fill
    var lastPt = gd[gd.length - 1];
    var lx = pad.left + (lastPt.tick / maxTick) * cw;
    ctx.lineTo(lx, pad.top + ch);
    ctx.lineTo(pad.left + (gd[0].tick / maxTick) * cw, pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = "rgba(74,158,110,0.1)";
    ctx.fill();

    // Current value dot
    var lastY = pad.top + ch - (lastPt.vocab_size / maxVocab) * ch;
    ctx.fillStyle = "#4a9e6e";
    ctx.beginPath(); ctx.arc(lx, lastY, 4, 0, Math.PI * 2); ctx.fill();

    // Model label
    ctx.fillStyle = "#4a9e6e";
    ctx.font = "bold 10px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText("Model: " + (gc.growth_model || "?") + "  |  R\u00B2 = " + (gc.r_squared || 0).toFixed(3), w - pad.right, pad.top + 12);

    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Tick", w / 2, h - 5);
  }

  // --- Network Analysis ---
  function drawNetworkAnalysisChart() {
    var r = setupCanvas("chart-network-analysis");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sci = state.science || {};
    var net = sci.network || {};
    if (!net.node_count) { drawNoData(ctx, w, h, "Waiting for network data..."); return; }

    var pad = { top: 15, bottom: 10, left: 10, right: 10 };

    // Left panel: key metrics
    var netMetrics = [
      { label: "Nodes", value: net.node_count || 0 },
      { label: "Edges", value: net.edge_count || 0 },
      { label: "Density", value: (net.edge_density || 0).toFixed(3) },
      { label: "Clustering", value: (net.clustering_coefficient || 0).toFixed(3) },
      { label: "Avg Path", value: (net.avg_path_length || 0).toFixed(2) },
    ];

    var leftW = w * 0.4;
    ctx.font = "10px 'JetBrains Mono', monospace";
    netMetrics.forEach(function(m, idx) {
      var my = pad.top + 20 + idx * 28;
      ctx.fillStyle = "rgba(90,84,101,0.6)";
      ctx.textAlign = "left";
      ctx.fillText(m.label, pad.left + 8, my);
      ctx.fillStyle = "#f0e0cc";
      ctx.font = "bold 13px 'JetBrains Mono', monospace";
      ctx.fillText(String(m.value), pad.left + 8, my + 16);
      ctx.font = "10px 'JetBrains Mono', monospace";
    });

    // Right panel: degree distribution bar chart
    var dd = net.degree_distribution || {};
    var degrees = Object.keys(dd).map(Number).sort(function(a, b) { return a - b; });
    if (degrees.length > 0) {
      var rightX = leftW + 10;
      var rightW = w - rightX - pad.right;
      var barH = h - pad.top - pad.bottom - 30;
      var maxCount = 0;
      degrees.forEach(function(d) { if (dd[d] > maxCount) maxCount = dd[d]; });
      if (maxCount === 0) maxCount = 1;

      ctx.fillStyle = "rgba(90,84,101,0.5)";
      ctx.font = "9px 'Inter', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Degree Distribution", rightX + rightW / 2, pad.top + 10);

      var bW = Math.max(4, Math.min(20, (rightW - 10) / degrees.length - 2));
      var totalBarsW = degrees.length * (bW + 2);
      var startX = rightX + (rightW - totalBarsW) / 2;

      degrees.forEach(function(d, idx) {
        var count = dd[d];
        var bh = (count / maxCount) * (barH - 20);
        var bx = startX + idx * (bW + 2);
        var by = pad.top + 20 + (barH - 20) - bh;
        ctx.fillStyle = "#5a9bba";
        ctx.fillRect(bx, by, bW, bh);
        ctx.fillStyle = "rgba(90,84,101,0.5)";
        ctx.font = "7px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText(d, bx + bW / 2, pad.top + barH + 8);
      });
    }

    // Structured vs random
    var comp = net.comparison_to_random || {};
    if (comp.more_structured_than_random != null) {
      ctx.fillStyle = comp.more_structured_than_random ? "rgba(74,158,110,0.7)" : "rgba(196,74,32,0.7)";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText(comp.more_structured_than_random ? "MORE structured than random" : "Similar to random graph", pad.left + 8, h - 12);
    }
  }

  // --- Influence Ranking (PageRank) ---
  function drawInfluenceChart() {
    var r = setupCanvas("chart-influence");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sci = state.science || {};
    var infl = sci.influence || {};
    var ranking = infl.influence_ranking || [];
    if (ranking.length === 0) { drawNoData(ctx, w, h, "Waiting for influence data..."); return; }

    var pad = { top: 10, bottom: 10, left: 10, right: 10 };
    var maxScore = 0;
    ranking.forEach(function(item) { if (item.influence_score > maxScore) maxScore = item.influence_score; });
    if (maxScore === 0) maxScore = 1;

    var citizens = getCitizens();
    var nameMap = {};
    citizens.forEach(function(c) { nameMap[c.id] = c.name; });

    var bH = Math.max(12, Math.min(22, (h - pad.top - pad.bottom) / ranking.length - 2));
    var nameW = 80;
    var barAreaW = w - pad.left - pad.right - nameW - 60;

    ranking.slice(0, 15).forEach(function(item, idx) {
      var y = pad.top + idx * (bH + 3);
      var name = nameMap[item.citizen] || item.citizen.substring(0, 8);

      ctx.fillStyle = "rgba(90,84,101,0.7)";
      ctx.font = "10px 'Inter', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(name, pad.left + nameW - 4, y + bH - 3);

      var bw = (item.influence_score / maxScore) * barAreaW;
      ctx.fillStyle = PALETTE[idx % PALETTE.length];
      roundedRect(ctx, pad.left + nameW, y, bw, bH, 3);
      ctx.fill();

      ctx.fillStyle = "#f0e0cc";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText((item.influence_score * 100).toFixed(1) + "%", pad.left + nameW + bw + 4, y + bH - 3);
    });
  }

  // --- Cascade Cards (DOM-based, safe text content) ---
  function renderCascadeCards() {
    var container = byId("cascade-cards-container");
    if (!container) return;
    clearEl(container);
    var sci = state.science || {};
    var cascades = sci.cascades || [];
    if (!Array.isArray(cascades) || cascades.length === 0) {
      container.appendChild(createEl("span", "muted-text", "No cascades detected yet"));
      return;
    }
    var citizens = getCitizens();
    var nameMap = {};
    citizens.forEach(function(c) { nameMap[c.id] = c.name; });

    cascades.forEach(function(c) {
      var card = createEl("div", "cascade-card");
      var top = createEl("div", null);
      top.style.display = "flex";
      top.style.justifyContent = "space-between";
      top.style.alignItems = "center";
      top.appendChild(createEl("span", "cascade-sound", c.sound || "?"));
      top.appendChild(createEl("span", "cascade-meaning", c.meaning || "?"));
      card.appendChild(top);

      var stats = createEl("div", "cascade-stats");
      var originName = nameMap[c.origin_citizen] || (c.origin_citizen || "?").substring(0, 8);
      var parts = [
        "Origin: " + originName,
        "Adopters: " + (c.total_adopters || 0),
        "Spread: " + (c.ticks_to_spread || 0) + " ticks",
        "Velocity: " + (c.cascade_velocity || 0).toFixed(2)
      ];
      stats.textContent = parts.join(" \u00B7 ");
      card.appendChild(stats);
      container.appendChild(card);
    });
  }

  // --- Communication Efficiency ---
  function drawCommEfficiencyChart() {
    var r = setupCanvas("chart-comm-efficiency");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sci = state.science || {};
    var eff = sci.efficiency || {};
    var srData = eff.success_rate_over_time || [];
    var alData = eff.avg_length_over_time || [];

    if (srData.length < 2 && alData.length < 2) {
      drawNoData(ctx, w, h, "Accumulating efficiency data...");
      return;
    }

    var pad = { top: 20, bottom: 30, left: 45, right: 45 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    var allTicks = [];
    srData.forEach(function(d) { allTicks.push(d.tick_bucket); });
    alData.forEach(function(d) { allTicks.push(d.tick_bucket); });
    var minTick = Math.min.apply(null, allTicks);
    var maxTick = Math.max.apply(null, allTicks);
    if (maxTick === minTick) maxTick = minTick + 1;

    // Grid
    ctx.strokeStyle = "rgba(30,30,42,0.5)";
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.top + ch - (gi / 4) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(w - pad.right, gy); ctx.stroke();
    }

    // Success rate line (left axis, green)
    if (srData.length >= 2) {
      ctx.strokeStyle = "#4a9e6e";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      srData.forEach(function(d, idx) {
        var x = pad.left + ((d.tick_bucket - minTick) / (maxTick - minTick)) * cw;
        var y = pad.top + ch - (d.success_rate || 0) * ch;
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      ctx.fillStyle = "#4a9e6e";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "right";
      for (var li = 0; li <= 4; li++) {
        ctx.fillText((li * 25) + "%", pad.left - 4, pad.top + ch - (li / 4) * ch + 3);
      }
      ctx.font = "10px 'Inter', sans-serif";
      ctx.save();
      ctx.translate(10, h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("Success %", 0, 0);
      ctx.restore();
    }

    // Avg length line (right axis, blue, dashed)
    if (alData.length >= 2) {
      var maxLen = 0;
      alData.forEach(function(d) { if (d.avg_utterance_length > maxLen) maxLen = d.avg_utterance_length; });
      if (maxLen === 0) maxLen = 1;
      maxLen *= 1.2;

      ctx.strokeStyle = "#5a9bba";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      alData.forEach(function(d, idx) {
        var x = pad.left + ((d.tick_bucket - minTick) / (maxTick - minTick)) * cw;
        var y = pad.top + ch - (d.avg_utterance_length / maxLen) * ch;
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#5a9bba";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      for (var ri = 0; ri <= 4; ri++) {
        ctx.fillText((ri / 4 * maxLen).toFixed(1), w - pad.right + 4, pad.top + ch - (ri / 4) * ch + 3);
      }
    }

    // Legend
    ctx.fillStyle = "#4a9e6e";
    ctx.fillRect(pad.left, pad.top - 12, 12, 3);
    ctx.fillStyle = "rgba(90,84,101,0.7)";
    ctx.font = "9px 'Inter', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Success Rate", pad.left + 16, pad.top - 8);
    ctx.fillStyle = "#5a9bba";
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#5a9bba";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pad.left + 110, pad.top - 10); ctx.lineTo(pad.left + 122, pad.top - 10); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(90,84,101,0.7)";
    ctx.fillText("Avg Length", pad.left + 126, pad.top - 8);

    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Tick", w / 2, h - 5);
  }

  // --- Context Type Donut ---
  function drawContextDonutChart() {
    var r = setupCanvas("chart-context-donut");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var utterances = state.recent_utterances || [];
    if (utterances.length === 0) { drawNoData(ctx, w, h, "Waiting for utterance data..."); return; }

    var counts = {};
    utterances.forEach(function(u) {
      var ct = u.context_type || "unknown";
      counts[ct] = (counts[ct] || 0) + 1;
    });

    var types = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; });
    var total = utterances.length;

    var dcx = w * 0.4;
    var dcy = h * 0.5;
    var outerR = Math.min(w * 0.3, h * 0.4);
    var innerR = outerR * 0.55;

    var startA = -Math.PI / 2;
    var dColors = ["#d4a574", "#4a9e6e", "#5a9bba", "#8a6abf", "#c4648c", "#c44a20", "#d48a34", "#c4c44a"];

    types.forEach(function(type, idx) {
      var sliceAngle = (counts[type] / total) * Math.PI * 2;
      var endA = startA + sliceAngle;

      ctx.fillStyle = dColors[idx % dColors.length];
      ctx.beginPath();
      ctx.arc(dcx, dcy, outerR, startA, endA);
      ctx.arc(dcx, dcy, innerR, endA, startA, true);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "#0a0a0f";
      ctx.lineWidth = 2;
      ctx.stroke();

      startA = endA;
    });

    // Center text
    ctx.fillStyle = "#f0e0cc";
    ctx.font = "bold 20px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(total, dcx, dcy + 4);
    ctx.fillStyle = "rgba(90,84,101,0.6)";
    ctx.font = "9px 'Inter', sans-serif";
    ctx.fillText("utterances", dcx, dcy + 18);

    // Legend
    var legendX = w * 0.68;
    var legendY = 20;
    types.forEach(function(type, idx) {
      var ly = legendY + idx * 20;
      if (ly > h - 10) return;
      ctx.fillStyle = dColors[idx % dColors.length];
      ctx.fillRect(legendX, ly, 10, 10);
      ctx.fillStyle = "rgba(90,84,101,0.8)";
      ctx.font = "10px 'Inter', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(type + " (" + counts[type] + ")", legendX + 15, ly + 9);
    });
  }

  // --- Interaction Heatmap ---
  function drawInteractionHeatmap() {
    var r = setupCanvas("chart-heatmap");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var rels = state.relationships || [];
    if (rels.length === 0) { drawNoData(ctx, w, h, "Waiting for relationship data..."); return; }

    var citizens = getCitizens();
    if (citizens.length === 0) { drawNoData(ctx, w, h); return; }
    var names = citizens.map(function(c) { return c.name; });
    var ids = citizens.map(function(c) { return c.id; });
    var n = ids.length;

    // Build matrix
    var matrix = [];
    for (var mi = 0; mi < n; mi++) {
      matrix[mi] = [];
      for (var mj = 0; mj < n; mj++) matrix[mi][mj] = 0;
    }
    var idIdx = {};
    ids.forEach(function(id, idx) { idIdx[id] = idx; });
    var maxScore = 0;
    rels.forEach(function(rel) {
      var ai = idIdx[rel.citizen_a];
      var bi = idIdx[rel.citizen_b];
      if (ai != null && bi != null) {
        matrix[ai][bi] = rel.score;
        matrix[bi][ai] = rel.score;
        if (Math.abs(rel.score) > maxScore) maxScore = Math.abs(rel.score);
      }
    });
    if (maxScore === 0) maxScore = 1;

    var pad = { top: 8, bottom: 8, left: 60, right: 8 };
    var gridW = w - pad.left - pad.right;
    var gridH = h - pad.top - pad.bottom - 20;
    var cellW = gridW / n;
    var cellH = gridH / n;
    var topLabelH = 20;

    // Column labels
    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "8px 'Inter', sans-serif";
    ctx.textAlign = "left";
    names.forEach(function(name, idx) {
      ctx.save();
      ctx.translate(pad.left + idx * cellW + cellW / 2, pad.top + topLabelH - 2);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(name.substring(0, 6), 0, 0);
      ctx.restore();
    });

    // Row labels + cells
    names.forEach(function(name, ri) {
      var ry = pad.top + topLabelH + ri * cellH;
      ctx.fillStyle = "rgba(90,84,101,0.5)";
      ctx.font = "8px 'Inter', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(name.substring(0, 6), pad.left - 4, ry + cellH / 2 + 3);

      for (var ci = 0; ci < n; ci++) {
        var cellX = pad.left + ci * cellW;
        var val = matrix[ri][ci];
        var norm = val / maxScore;
        if (val > 0) {
          ctx.fillStyle = "rgba(74,158,110," + (0.1 + norm * 0.8).toFixed(2) + ")";
        } else if (val < 0) {
          ctx.fillStyle = "rgba(196,74,32," + (0.1 + Math.abs(norm) * 0.8).toFixed(2) + ")";
        } else {
          ctx.fillStyle = "rgba(30,30,42,0.3)";
        }
        ctx.fillRect(cellX + 1, ry + 1, cellW - 2, cellH - 2);
      }
    });
  }

  // --- Milestone Timeline ---
  function drawMilestoneTimeline() {
    var r = setupCanvas("chart-milestone-timeline");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var milestones = state.milestones || [];
    if (milestones.length === 0) { drawNoData(ctx, w, h, "No milestones achieved yet"); return; }

    var pad = { top: 30, bottom: 40, left: 40, right: 40 };
    var cw = w - pad.left - pad.right;
    var lineY = h * 0.45;

    var minTick = milestones[0].tick;
    var maxTick = milestones[milestones.length - 1].tick;
    if (maxTick === minTick) maxTick = minTick + 100;

    // Timeline line
    ctx.strokeStyle = "rgba(30,30,42,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(w - pad.right, lineY);
    ctx.stroke();

    var mColors = ["#c44a20", "#d48a34", "#d4a574", "#c4c44a", "#4a9e6e", "#5a9bba", "#8a6abf"];
    milestones.forEach(function(m, idx) {
      var x = pad.left + ((m.tick - minTick) / (maxTick - minTick)) * cw;
      var above = idx % 2 === 0;

      // Vertical connector
      ctx.strokeStyle = mColors[idx % mColors.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, lineY);
      ctx.lineTo(x, above ? lineY - 40 : lineY + 40);
      ctx.stroke();

      // Dot
      ctx.fillStyle = mColors[idx % mColors.length];
      ctx.beginPath();
      ctx.arc(x, lineY, 5, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.font = "bold 9px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(m.milestone.replace(/_/g, " "), x, above ? lineY - 48 : lineY + 52);

      ctx.fillStyle = "rgba(90,84,101,0.5)";
      ctx.font = "8px 'JetBrains Mono', monospace";
      ctx.fillText("T" + m.tick, x, above ? lineY - 60 : lineY + 64);
    });

    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Timeline (by tick)", w / 2, h - 10);
  }

  // --- Death Statistics ---
  function drawDeathStatsChart() {
    var r = setupCanvas("chart-death-stats");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var deaths = state.deaths || [];
    if (deaths.length === 0) { drawNoData(ctx, w, h, "No deaths recorded yet"); return; }

    var causes = {};
    deaths.forEach(function(d) {
      var cause = d.cause || "unknown";
      causes[cause] = (causes[cause] || 0) + 1;
    });

    var sorted = Object.keys(causes).sort(function(a, b) { return causes[b] - causes[a]; });
    var maxCount = causes[sorted[0]] || 1;

    var pad = { top: 10, bottom: 10, left: 90, right: 30 };
    var barAreaW = w - pad.left - pad.right;
    var bH = Math.max(14, Math.min(24, (h - pad.top - pad.bottom) / sorted.length - 4));

    var causeColors = { starvation: "#c44a20", dehydration: "#d48a34", cold: "#5a9bba", predator: "#c4648c", age: "#8a6abf", unknown: "#807a6e" };

    sorted.forEach(function(cause, idx) {
      var y = pad.top + idx * (bH + 4);
      var count = causes[cause];
      var bw = (count / maxCount) * barAreaW;

      ctx.fillStyle = "rgba(90,84,101,0.7)";
      ctx.font = "10px 'Inter', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(cause, pad.left - 6, y + bH - 4);

      ctx.fillStyle = causeColors[cause] || PALETTE[idx % PALETTE.length];
      roundedRect(ctx, pad.left, y, bw, bH, 3);
      ctx.fill();

      ctx.fillStyle = "#f0e0cc";
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText(count, pad.left + bw + 6, y + bH - 4);
    });
  }

  // --- World Comparison ---
  function drawWorldComparisonChart() {
    var r = setupCanvas("chart-world-comparison");
    if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var worlds = state.worlds || [];
    if (worlds.length === 0) { drawNoData(ctx, w, h, "No world history yet"); return; }

    var pad = { top: 25, bottom: 35, left: 45, right: 15 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;
    var wn = worlds.length;
    var groupW = cw / wn;
    var bW = Math.max(6, Math.min(16, groupW / 4));

    var maxTicks = 0, maxInter = 0, maxWords = 0;
    worlds.forEach(function(wd) {
      if ((wd.ticks || 0) > maxTicks) maxTicks = wd.ticks;
      if ((wd.interactions || 0) > maxInter) maxInter = wd.interactions;
      if ((wd.shared_words || 0) > maxWords) maxWords = wd.shared_words;
    });
    if (maxTicks === 0) maxTicks = 1;
    if (maxInter === 0) maxInter = 1;
    if (maxWords === 0) maxWords = 1;

    // Legend
    var legendItems = [
      { label: "Ticks", color: "#5a9bba" },
      { label: "Interactions", color: "#d4a574" },
      { label: "Shared Words", color: "#4a9e6e" }
    ];
    legendItems.forEach(function(item, idx) {
      var lx = pad.left + idx * 100;
      ctx.fillStyle = item.color;
      ctx.fillRect(lx, 5, 10, 10);
      ctx.fillStyle = "rgba(90,84,101,0.7)";
      ctx.font = "9px 'Inter', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(item.label, lx + 14, 14);
    });

    worlds.forEach(function(wd, idx) {
      var gx = pad.left + idx * groupW + groupW / 2;

      var th = ((wd.ticks || 0) / maxTicks) * ch;
      ctx.fillStyle = "#5a9bba";
      ctx.fillRect(gx - bW * 1.5 - 1, pad.top + ch - th, bW, th);

      var ih2 = ((wd.interactions || 0) / maxInter) * ch;
      ctx.fillStyle = "#d4a574";
      ctx.fillRect(gx - bW / 2, pad.top + ch - ih2, bW, ih2);

      var wh = ((wd.shared_words || 0) / maxWords) * ch;
      ctx.fillStyle = "#4a9e6e";
      ctx.fillRect(gx + bW / 2 + 1, pad.top + ch - wh, bW, wh);

      ctx.fillStyle = "rgba(90,84,101,0.7)";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("W" + (wd.world_id || idx + 1), gx, h - 10);
    });

    ctx.strokeStyle = "rgba(30,30,42,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ch);
    ctx.lineTo(w - pad.right, pad.top + ch);
    ctx.stroke();
  }

  function renderMilestones() {
    var container = byId("milestones-container");
    if (!container) return;
    clearEl(container);

    var milestones = state.milestones || [];
    if (milestones.length === 0) {
      container.appendChild(createEl("span", "muted-text", "No milestones achieved yet"));
      return;
    }

    milestones.forEach(function (m) {
      var badge = createEl("div", "milestone-badge");
      badge.appendChild(createSpan(null, m.milestone));
      badge.appendChild(createSpan("milestone-tick", " T" + m.tick));
      if (m.description) {
        badge.appendChild(createEl("span", "milestone-desc", " — " + m.description));
      }
      container.appendChild(badge);
    });
  }

  function drawCitizenVocabChart() {
    var canvas = byId("chart-citizen-vocab");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    if (w < 1 || h < 1) return;
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    var rw = w / dpr;
    var rh = h / dpr;
    ctx.clearRect(0, 0, rw, rh);

    var citizens = getCitizens();
    if (citizens.length === 0) { ctx.restore(); return; }

    // Draw per-citizen vocab lines
    var maxLen = 0;
    var maxVal = 0;
    citizens.forEach(function (c) {
      var arr = history.citizen_vocab[c.id] || [];
      if (arr.length > maxLen) maxLen = arr.length;
      arr.forEach(function (v) { if (v > maxVal) maxVal = v; });
    });

    if (maxLen < 2 || maxVal === 0) {
      ctx.fillStyle = "rgba(90,84,101,0.6)";
      ctx.font = "12px 'Inter', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for data...", rw / 2, rh / 2);
      ctx.restore();
      return;
    }

    var pad = { top: 10, bottom: 30, left: 10, right: 10 };
    var chartW = rw - pad.left - pad.right;
    var chartH = rh - pad.top - pad.bottom;

    citizens.forEach(function (c, ci) {
      var arr = history.citizen_vocab[c.id] || [];
      if (arr.length < 2) return;
      var color = PALETTE[ci % PALETTE.length];

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      arr.forEach(function (v, i) {
        var x = pad.left + (i / (maxLen - 1)) * chartW;
        var y = pad.top + chartH - (v / maxVal) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Label at end of line
      var lastVal = arr[arr.length - 1];
      var lastX = pad.left + ((arr.length - 1) / (maxLen - 1)) * chartW;
      var lastY = pad.top + chartH - (lastVal / maxVal) * chartH;
      ctx.fillStyle = color;
      ctx.font = "9px 'Inter', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(c.name, lastX + 4, lastY + 3);
    });

    // X-axis label
    ctx.fillStyle = "rgba(90,84,101,0.5)";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Time (polling intervals)", rw / 2, rh - 5);

    ctx.restore();
  }

  function renderCitizenSuccessBars() {
    var container = byId("citizen-success-bars");
    if (!container) return;
    clearEl(container);

    var citizens = getCitizens();
    var utterances = state.recent_utterances || [];

    citizens.forEach(function (c, ci) {
      var total = 0;
      var success = 0;
      utterances.forEach(function (u) {
        if (u.citizen_id === c.id) {
          total++;
          if (u.success) success++;
        }
      });

      var pct = total > 0 ? ((success / total) * 100) : 0;

      var row = createEl("div", "vocab-bar-row");
      row.appendChild(createEl("span", "vocab-bar-name", c.name));
      var track = createEl("div", "vocab-bar-track");
      var fill = createEl("div", "vocab-bar-fill");
      fill.style.width = pct.toFixed(0) + "%";
      fill.style.background = PALETTE[ci % PALETTE.length];
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(createEl("span", "vocab-bar-count", pct.toFixed(0) + "%"));
      container.appendChild(row);
    });
  }

  function renderIntelligenceStats() {
    var container = byId("intelligence-stats");
    if (!container) return;
    clearEl(container);

    var ustats = state.utterance_stats || {};
    var utterances = state.recent_utterances || [];
    var lexByCitizen = state.lexicon_by_citizen || {};

    // Average utterance length
    var totalLen = 0;
    var count = 0;
    utterances.forEach(function (u) {
      if (u.utterance) {
        totalLen += u.utterance.split(/\s+/).length;
        count++;
      }
    });
    var avgLen = count > 0 ? (totalLen / count).toFixed(1) : "0";

    // Total unique sounds across all citizens
    var allSounds = new Set();
    for (var cid in lexByCitizen) {
      (lexByCitizen[cid] || []).forEach(function (v) { allSounds.add(v.sound); });
    }

    addIntelStat(container, "Total Utterances", formatNumber(ustats.total_utterances || 0));
    addIntelStat(container, "Successful Communications", formatNumber(ustats.successful || 0));
    addIntelStat(container, "Active Speakers", String(ustats.active_speakers || 0));
    addIntelStat(container, "Avg. Words per Utterance", avgLen);
    addIntelStat(container, "Total Unique Sounds", String(allSounds.size));
    addIntelStat(container, "Shared Vocabulary", String(state.shared_lexicon ? state.shared_lexicon.length : 0));
    addIntelStat(container, "Breeding Events", String((state.breeding_events || []).length));
  }

  function addIntelStat(container, label, value) {
    var row = createEl("div", "intel-stat-row");
    row.appendChild(createEl("span", "intel-stat-label", label));
    row.appendChild(createEl("span", "intel-stat-value", value));
    container.appendChild(row);
  }

  // ---------------------------------------------------------------------------
  // Chart Utilities
  // ---------------------------------------------------------------------------

  function drawLineChart(canvasId, data, color, suffix, label) {
    var canvas = byId(canvasId);
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    if (w < 1 || h < 1) return;
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    var rw = w / dpr;
    var rh = h / dpr;
    ctx.clearRect(0, 0, rw, rh);

    if (data.length < 2) {
      ctx.fillStyle = "rgba(90,84,101,0.6)";
      ctx.font = "12px 'Inter', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Accumulating data...", rw / 2, rh / 2);
      ctx.restore();
      return;
    }

    var pad = { top: 15, bottom: 25, left: 40, right: 15 };
    var chartW = rw - pad.left - pad.right;
    var chartH = rh - pad.top - pad.bottom;

    var min = Math.min.apply(null, data);
    var max = Math.max.apply(null, data);
    var range = max - min || 1;

    // Y-axis labels
    ctx.fillStyle = "rgba(90,84,101,0.6)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    for (var yi = 0; yi <= 4; yi++) {
      var yVal = min + (yi / 4) * range;
      var yPos = pad.top + chartH - (yi / 4) * chartH;
      ctx.fillText(yVal.toFixed(suffix === "%" ? 1 : 0) + suffix, pad.left - 4, yPos + 3);

      // Grid line
      ctx.strokeStyle = "rgba(30,30,42,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, yPos);
      ctx.lineTo(rw - pad.right, yPos);
      ctx.stroke();
    }

    // Line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    data.forEach(function (v, i) {
      var x = pad.left + (i / (data.length - 1)) * chartW;
      var y = pad.top + chartH - ((v - min) / range) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Area fill
    var lastX = pad.left + ((data.length - 1) / (data.length - 1)) * chartW;
    ctx.lineTo(lastX, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = color + "15";
    ctx.fill();

    // Current value indicator
    var lastVal = data[data.length - 1];
    var lastY = pad.top + chartH - ((lastVal - min) / range) * chartH;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText(lastVal.toFixed(suffix === "%" ? 1 : 0) + suffix, lastX + 6, lastY + 3);

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  // ===========================================================================
  // NEW FEATURES (40 enhancements)
  // ===========================================================================

  // --- Feature 2: localStorage history persistence ---
  function saveHistoryToStorage() {
    try { localStorage.setItem("wm_history", JSON.stringify(history)); localStorage.setItem("wm_history_ts", String(Date.now())); } catch (_) {}
  }
  function loadHistoryFromStorage() {
    try {
      var s = localStorage.getItem("wm_history"), ts = parseInt(localStorage.getItem("wm_history_ts") || "0");
      if (s && Date.now() - ts < 3600000) {
        var p = JSON.parse(s);
        if (p.vocab_size) history.vocab_size = p.vocab_size;
        if (p.success_rate) history.success_rate = p.success_rate;
        if (p.citizen_vocab) history.citizen_vocab = p.citizen_vocab;
        log(LOG_LEVEL.INFO, "storage", "Restored " + history.vocab_size.length + " history points");
      }
    } catch (_) {}
  }

  // --- Feature 3: Citizen click-to-inspect ---
  var inspectedCitizenId = null;
  function openInspectPanel(cid) {
    inspectedCitizenId = cid;
    var p = byId("inspect-panel"); if (p) p.classList.add("open");
    renderInspectPanel();
  }
  function closeInspectPanel() {
    inspectedCitizenId = null;
    var p = byId("inspect-panel"); if (p) p.classList.remove("open");
  }
  function renderInspectPanel() {
    var body = byId("inspect-body"), nameEl = byId("inspect-name");
    if (!body || !inspectedCitizenId) return;
    clearEl(body);
    var c = null; getCitizens().forEach(function(ci) { if (ci.id === inspectedCitizenId) c = ci; });
    if (!c) { closeInspectPanel(); return; }
    setText(nameEl, c.name + " (" + (c.role || "?") + ")");

    // Locate on map button
    var locateBtn = createEl("button", "citizen-action-btn", "Locate on Map");
    locateBtn.style.marginBottom = "10px";
    locateBtn.style.width = "100%";
    locateBtn.addEventListener("click", function() {
      // Center map on this citizen
      if (c.x != null && c.y != null) {
        var canvas = byId("map-canvas");
        if (canvas) {
          var rect = canvas.getBoundingClientRect();
          var scaleX = rect.width / ENV_COLS, scaleY = rect.height / ENV_ROWS;
          var baseScale = Math.max(scaleX, scaleY);
          var scale = baseScale * mapZoom;
          var screenX = (c.x / TILE_PX) * scale;
          var screenY = (c.y / TILE_PX) * scale;
          mapPanX = rect.width / 2 - screenX;
          mapPanY = rect.height / 2 - screenY;
          if (mapZoom < 3) mapZoom = 3;
          switchTab("overview");
        }
      }
    });
    body.appendChild(locateBtn);

    // Vitals
    var sec = createEl("div", "inspect-section");
    sec.appendChild(createEl("div", "inspect-section-title", "VITALS"));
    [["Age", c.age], ["Sex", c.sex], ["Status", c.status], ["Mood", c.mood != null ? c.mood.toFixed(2) : "--"], ["Energy", c.energy != null ? c.energy.toFixed(2) : "--"], ["Position", Math.round(c.x || 0) + ", " + Math.round(c.y || 0)]].forEach(function(s) {
      var row = createEl("div", "inspect-stat");
      row.appendChild(createEl("span", "inspect-stat-label", s[0]));
      row.appendChild(createEl("span", "inspect-stat-value", String(s[1])));
      sec.appendChild(row);
    });
    if (c.hunger != null) { var r = createEl("div", "inspect-stat"); r.appendChild(createEl("span", "inspect-stat-label", "Hunger")); r.appendChild(createEl("span", "inspect-stat-value", c.hunger.toFixed(2))); sec.appendChild(r); }
    if (c.thirst != null) { var r2 = createEl("div", "inspect-stat"); r2.appendChild(createEl("span", "inspect-stat-label", "Thirst")); r2.appendChild(createEl("span", "inspect-stat-value", c.thirst.toFixed(2))); sec.appendChild(r2); }
    body.appendChild(sec);
    // Vocab
    var lex = (state.lexicon_by_citizen || {})[c.id] || [];
    if (lex.length > 0) {
      var vs = createEl("div", "inspect-section"); vs.appendChild(createEl("div", "inspect-section-title", "VOCABULARY (" + lex.length + ")"));
      lex.slice(0, 30).forEach(function(v) {
        var tag = createEl("span", "inspect-vocab-tag", v.sound + "=" + v.meaning);
        tag.onclick = function() { if (typeof playProtoSound === "function") playProtoSound(v.sound); };
        vs.appendChild(tag);
      });
      body.appendChild(vs);
    }
    // Memories (Feature 37)
    var mems = (state.memories_by_citizen || {})[c.id] || [];
    if (mems.length > 0) {
      var ms = createEl("div", "inspect-section"); ms.appendChild(createEl("div", "inspect-section-title", "MEMORIES"));
      mems.forEach(function(m) { ms.appendChild(createEl("div", "inspect-memory-item", "T" + m.tick + ": " + m.event)); });
      body.appendChild(ms);
    }
    // Relationships
    var rels = (state.relationships || []).filter(function(r) { return r.citizen_a === c.id || r.citizen_b === c.id; });
    if (rels.length > 0) {
      var rs = createEl("div", "inspect-section"); rs.appendChild(createEl("div", "inspect-section-title", "RELATIONSHIPS"));
      rels.sort(function(a, b) { return Math.abs(b.score) - Math.abs(a.score); }).slice(0, 10).forEach(function(r) {
        var oid = r.citizen_a === c.id ? r.citizen_b : r.citizen_a;
        var row = createEl("div", "inspect-stat");
        row.appendChild(createEl("span", "inspect-stat-label", findCitizenName(oid) + " (" + (r.type || "?") + ")"));
        row.appendChild(createEl("span", "inspect-stat-value", r.score.toFixed(2)));
        rs.appendChild(row);
      });
      body.appendChild(rs);
    }
  }

  // --- Feature 8: Snapshot scrubber ---
  function initScrubber() {
    var range = byId("scrubber-range"), liveBtn = byId("scrubber-live"), bar = byId("scrubber-bar");
    if (!range || !bar) return;
    range.addEventListener("input", function() {
      var snaps = (state && state.snapshots) || [];
      if (snaps.length === 0) return;
      var idx = Math.round((parseInt(range.value) / 100) * (snaps.length - 1));
      var snap = snaps[idx];
      setText("scrubber-tick", snap ? "T" + snap.tick + " | Day " + snap.day : "Live");
    });
    if (liveBtn) liveBtn.addEventListener("click", function() { range.value = 100; setText("scrubber-tick", "Live"); });
  }

  // --- Feature 9: Citizen comparison ---
  var compareIds = [];
  function addToCompare(cid) {
    if (compareIds.indexOf(cid) === -1 && compareIds.length < 2) compareIds.push(cid);
    if (compareIds.length === 2) {
      var panel = byId("compare-panel"), body = byId("compare-body");
      if (!panel || !body) return; clearEl(body); panel.style.display = "block";
      var citizens = getCitizens();
      compareIds.forEach(function(id) {
        var c = null; citizens.forEach(function(ci) { if (ci.id === id) c = ci; });
        if (!c) return;
        var col = createEl("div");
        col.appendChild(createEl("div", "inspect-section-title", c.name));
        [["Role", c.role], ["Age", c.age], ["Mood", c.mood != null ? c.mood.toFixed(2) : "--"], ["Vocab", ((state.lexicon_by_citizen || {})[c.id] || []).length]].forEach(function(s) {
          var row = createEl("div", "inspect-stat"); row.appendChild(createEl("span", "inspect-stat-label", s[0])); row.appendChild(createEl("span", "inspect-stat-value", String(s[1]))); col.appendChild(row);
        });
        body.appendChild(col);
      });
    }
  }

  // --- Feature 10: Semantic field chart ---
  function drawSemanticFieldChart() {
    var r = setupCanvas("chart-semantic-fields"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sf = (state.science || {}).semantic_fields;
    if (!sf || sf.error) { drawNoData(ctx, w, h, "No semantic field data"); return; }
    var groups = sf.semantic_group_sizes || sf.category_vocab_sizes || {};
    var cats = Object.keys(groups).sort(function(a, b) { return groups[b] - groups[a]; });
    if (cats.length === 0) { drawNoData(ctx, w, h, "No semantic groups"); return; }
    var total = 0; cats.forEach(function(c) { total += groups[c]; }); if (total === 0) total = 1;
    var cx = w * 0.4, cy = h * 0.5, outerR = Math.min(w * 0.35, h * 0.42), innerR = outerR * 0.3;
    var startA = -Math.PI / 2, colors = ["#d4a574", "#4a9e6e", "#5a9bba", "#8a6abf", "#c4648c", "#c44a20", "#d48a34"];
    cats.forEach(function(cat, i) {
      var slice = (groups[cat] / total) * Math.PI * 2, endA = startA + slice;
      ctx.fillStyle = colors[i % colors.length]; ctx.beginPath();
      ctx.arc(cx, cy, outerR, startA, endA); ctx.arc(cx, cy, innerR, endA, startA, true);
      ctx.closePath(); ctx.fill(); ctx.strokeStyle = "#0a0a0f"; ctx.lineWidth = 2; ctx.stroke();
      startA = endA;
    });
    ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 16px 'JetBrains Mono', monospace"; ctx.textAlign = "center"; ctx.fillText(total, cx, cy + 4);
    var lx = w * 0.68, ly = 15;
    cats.forEach(function(cat, i) { if (ly + i * 18 > h) return; ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(lx, ly + i * 18, 10, 10); ctx.fillStyle = "rgba(90,84,101,0.8)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "left"; ctx.fillText(cat + " (" + groups[cat] + ")", lx + 15, ly + i * 18 + 9); });
  }

  // --- Feature 11: Survival curves ---
  function drawSurvivalCurves() {
    var r = setupCanvas("chart-survival-curves"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var deaths = state.deaths || [], citizens = getCitizens();
    if (deaths.length < 2) { drawNoData(ctx, w, h, "Need more death data"); return; }
    var pad = { top: 15, bottom: 30, left: 45, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var maxAge = 0; deaths.forEach(function(d) { if (d.age > maxAge) maxAge = d.age; }); if (maxAge === 0) maxAge = 50;
    var totalPop = citizens.length + deaths.length, survived = totalPop;
    var curve = []; for (var a = 0; a <= maxAge; a++) { var diedAt = deaths.filter(function(d) { return d.age === a; }).length; survived -= diedAt; curve.push(survived / totalPop); }
    ctx.strokeStyle = "#d4a574"; ctx.lineWidth = 2; ctx.beginPath();
    curve.forEach(function(s, i) { var x = pad.left + (i / maxAge) * cw, y = pad.top + ch - s * ch; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center"; ctx.fillText("Age", w / 2, h - 5);
    ctx.textAlign = "right"; ctx.font = "9px 'JetBrains Mono', monospace";
    for (var gi = 0; gi <= 4; gi++) { ctx.fillText((gi * 25) + "%", pad.left - 4, pad.top + ch - (gi / 4) * ch + 3); }
  }

  // --- Feature 12: Relationship type pie ---
  function drawRelTypesChart() {
    var r = setupCanvas("chart-rel-types"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, rels = state.relationships || [];
    if (rels.length === 0) { drawNoData(ctx, w, h, "No relationships"); return; }
    var types = {}; rels.forEach(function(r) { var t = r.type || "neutral"; types[t] = (types[t] || 0) + 1; });
    var keys = Object.keys(types).sort(function(a, b) { return types[b] - types[a]; }), total = rels.length;
    var cx = w * 0.4, cy = h * 0.5, outerR = Math.min(w * 0.3, h * 0.4), startA = -Math.PI / 2;
    var colors = ["#4a9e6e", "#d4a574", "#c44a20", "#5a9bba", "#8a6abf", "#c4648c"];
    keys.forEach(function(type, i) {
      var slice = (types[type] / total) * Math.PI * 2, endA = startA + slice;
      ctx.fillStyle = colors[i % colors.length]; ctx.beginPath(); ctx.arc(cx, cy, outerR, startA, endA); ctx.arc(cx, cy, outerR * 0.5, endA, startA, true); ctx.closePath(); ctx.fill(); ctx.strokeStyle = "#0a0a0f"; ctx.lineWidth = 2; ctx.stroke();
      startA = endA;
    });
    ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 16px 'JetBrains Mono', monospace"; ctx.textAlign = "center"; ctx.fillText(total, cx, cy + 4);
    var lx = w * 0.68, ly = 15;
    keys.forEach(function(type, i) { ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(lx, ly + i * 18, 10, 10); ctx.fillStyle = "rgba(90,84,101,0.8)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "left"; ctx.fillText(type + " (" + types[type] + ")", lx + 15, ly + i * 18 + 9); });
  }

  // --- Feature 13: Predation timeline ---
  function drawPredationTimeline() {
    var r = setupCanvas("chart-predation-timeline"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, fh = state.fauna_history || [];
    if (fh.length < 2) { drawNoData(ctx, w, h, "No predation data"); return; }
    var pad = { top: 10, bottom: 20, left: 30, right: 10 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var ticks = fh.map(function(f) { return f.tick; }), minT = Math.min.apply(null, ticks), maxT = Math.max.apply(null, ticks);
    if (maxT === minT) maxT = minT + 1;
    fh.forEach(function(f) {
      var x = pad.left + ((f.tick - minT) / (maxT - minT)) * cw, bw = Math.max(3, cw / fh.length - 1);
      var hunts = Array.isArray(f.recent_hunts) ? f.recent_hunts.length : 0;
      var attacks = Array.isArray(f.recent_attacks) ? f.recent_attacks.length : 0;
      ctx.fillStyle = "#4a9e6e"; ctx.fillRect(x, pad.top + ch - hunts * 8, bw, hunts * 8);
      ctx.fillStyle = "#c44a20"; ctx.fillRect(x, pad.top + ch - hunts * 8 - attacks * 8, bw, attacks * 8);
    });
  }

  // --- Feature 16: Export to CSV ---
  function exportTableToCSV(tableId, filename) {
    var table = byId(tableId); if (!table) return;
    var csv = []; table.querySelectorAll("tr").forEach(function(row) {
      var cells = []; row.querySelectorAll("th, td").forEach(function(cell) { cells.push('"' + cell.textContent.replace(/"/g, '""') + '"'); });
      csv.push(cells.join(","));
    });
    var blob = new Blob([csv.join("\n")], { type: "text/csv" }), url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = filename || "wildmind.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    var toast = byId("export-toast"); if (toast) { toast.classList.add("visible"); setTimeout(function() { toast.classList.remove("visible"); }, 2500); }
  }
  function exportLearningCSV() {
    var lines = ["tick,heaps_beta,zipf_coeff,clustering,shared_vocab"];
    (state.science_history || []).forEach(function(s) { var m = s.metrics || {}; lines.push([s.tick, (m.heaps || {}).heaps_beta || "", (m.zipf || {}).zipf_coefficient || "", (m.network || {}).clustering_coefficient || "", (m.growth_curve || {}).current_vocab_size || ""].join(",")); });
    var blob = new Blob([lines.join("\n")], { type: "text/csv" }), url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = "a_new_world_learning.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    var toast = byId("export-toast"); if (toast) { toast.classList.add("visible"); setTimeout(function() { toast.classList.remove("visible"); }, 2500); }
  }

  // --- Feature 19: Citizen search ---
  function initCitizenSearch() {
    var input = byId("citizen-search"); if (!input) return;
    var searchTimer = null;
    input.addEventListener("input", function() {
      clearTimeout(searchTimer);
      var q = input.value.toLowerCase().trim();
      if (!q) { closeInspectPanel(); return; }
      if (!state) return;
      searchTimer = setTimeout(function() {
        var match = getCitizens().find(function(c) { return c.name.toLowerCase().indexOf(q) !== -1; });
        if (match) openInspectPanel(match.id);
      }, 300);
    });
  }

  // --- Feature 22: Phoneme frequency ---
  function drawPhonemeFreqChart() {
    var r = setupCanvas("chart-phoneme-freq"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, lex = state.lexicon_by_citizen || {}, pc = {};
    for (var cid in lex) { (lex[cid] || []).forEach(function(v) { if (v.sound) v.sound.split("").forEach(function(ch) { if (/[a-z]/i.test(ch)) pc[ch.toLowerCase()] = (pc[ch.toLowerCase()] || 0) + 1; }); }); }
    var chars = Object.keys(pc).sort(function(a, b) { return pc[b] - pc[a]; });
    if (chars.length === 0) { drawNoData(ctx, w, h, "No phoneme data"); return; }
    var pad = { top: 10, bottom: 22, left: 10, right: 10 }, maxC = pc[chars[0]], shown = chars.slice(0, 26);
    var bw = Math.max(6, (w - pad.left - pad.right) / shown.length - 2), ch2 = h - pad.top - pad.bottom;
    shown.forEach(function(c, i) {
      var x = pad.left + i * (bw + 2), bh = (pc[c] / maxC) * ch2;
      ctx.fillStyle = "aeiou".indexOf(c) !== -1 ? "#d4a574" : "#5a9bba";
      ctx.fillRect(x, pad.top + ch2 - bh, bw, bh);
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "center"; ctx.fillText(c, x + bw / 2, h - 4);
    });
  }

  // --- Feature 23: Archetype comparison ---
  function drawArchetypeCompare() {
    var r = setupCanvas("chart-archetype-compare"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, citizens = getCitizens(), lex = state.lexicon_by_citizen || {};
    if (citizens.length === 0) { drawNoData(ctx, w, h, "No citizens"); return; }
    var byArch = {}; citizens.forEach(function(c) { var a = c.archetype || c.role || "?"; if (!byArch[a]) byArch[a] = { tv: 0, n: 0 }; byArch[a].tv += (lex[c.id] || []).length; byArch[a].n++; });
    var archs = Object.keys(byArch).sort(), pad = { top: 10, bottom: 10, left: 80, right: 20 }, bAreaW = w - pad.left - pad.right;
    var maxAvg = 0; archs.forEach(function(a) { var avg = byArch[a].tv / (byArch[a].n || 1); if (avg > maxAvg) maxAvg = avg; }); if (maxAvg === 0) maxAvg = 1;
    var bH = Math.max(14, Math.min(22, (h - pad.top - pad.bottom) / archs.length - 3));
    archs.forEach(function(arch, i) {
      var y = pad.top + i * (bH + 3), avg = byArch[arch].tv / (byArch[arch].n || 1), bw = (avg / maxAvg) * bAreaW;
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "right"; ctx.fillText(arch, pad.left - 6, y + bH - 4);
      ctx.fillStyle = PALETTE[i % PALETTE.length]; roundedRect(ctx, pad.left, y, bw, bH, 3); ctx.fill();
      ctx.fillStyle = "#f0e0cc"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "left"; ctx.fillText(avg.toFixed(1) + " avg", pad.left + bw + 6, y + bH - 4);
    });
  }

  // --- Feature 25: Connection latency ---
  function updateConnectionLatency() {
    if (lastPollMs <= 0) return;
    var el = byId("connection-label"); if (!el) return;
    var lat = el.parentNode.querySelector(".connection-latency");
    if (!lat) { lat = createEl("span", "connection-latency"); el.parentNode.appendChild(lat); }
    lat.textContent = " " + Math.round(lastPollMs) + "ms";
  }

  // --- Feature 26: Event frequency ---
  function drawEventFreqChart() {
    var r = setupCanvas("chart-event-freq"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, events = state.world_events || [];
    if (events.length < 3) { drawNoData(ctx, w, h, "Accumulating events..."); return; }
    var buckets = {}; events.forEach(function(e) { var b = Math.floor(e.tick / 50) * 50; buckets[b] = (buckets[b] || 0) + 1; });
    var ticks = Object.keys(buckets).map(Number).sort(function(a, b) { return a - b; });
    if (ticks.length < 2) return;
    var pad = { top: 10, bottom: 22, left: 30, right: 10 }, cw = w - pad.left - pad.right, ch2 = h - pad.top - pad.bottom;
    var maxC = 0; ticks.forEach(function(t) { if (buckets[t] > maxC) maxC = buckets[t]; }); if (maxC === 0) maxC = 1;
    var minT = ticks[0], maxT = ticks[ticks.length - 1]; if (maxT === minT) maxT = minT + 1;
    ctx.strokeStyle = "#c4648c"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    ticks.forEach(function(t, i) { var x = pad.left + ((t - minT) / (maxT - minT)) * cw, y = pad.top + ch2 - (buckets[t] / maxC) * ch2; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke(); ctx.lineTo(pad.left + cw, pad.top + ch2); ctx.lineTo(pad.left, pad.top + ch2); ctx.closePath(); ctx.fillStyle = "rgba(196,100,140,0.1)"; ctx.fill();
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center"; ctx.fillText("Events per 50 ticks", w / 2, h - 4);
  }

  // --- Feature 28: Mood heatmap ---
  function drawMoodHeatmap() {
    var r = setupCanvas("chart-mood-heatmap"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, citizens = getCitizens();
    if (citizens.length === 0) { drawNoData(ctx, w, h, "No citizens"); return; }
    var pad = { top: 10, bottom: 10, left: 65, right: 10 }, rowH = Math.max(8, Math.min(16, (h - pad.top - pad.bottom) / citizens.length));
    citizens.forEach(function(c, i) {
      var y = pad.top + i * rowH, mood = c.mood != null ? c.mood : 0, norm = (mood + 1) / 2;
      ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "right"; ctx.fillText(c.name.substring(0, 6), pad.left - 4, y + rowH - 2);
      ctx.fillStyle = mood >= 0 ? "rgba(74,158,110," + (0.2 + norm * 0.8).toFixed(2) + ")" : "rgba(196,74,32," + (0.2 + (1 - norm) * 0.8).toFixed(2) + ")";
      ctx.fillRect(pad.left, y, w - pad.left - pad.right, rowH - 1);
      ctx.fillStyle = "#f0e0cc"; ctx.font = "7px 'JetBrains Mono', monospace"; ctx.textAlign = "left"; ctx.fillText(mood.toFixed(1), pad.left + 4, y + rowH - 3);
    });
  }

  // --- Feature 36: Science delta indicators ---
  var prevSciVals = {};
  function updateScienceDeltas() {
    var sci = state.science || {};
    function check(key, val) {
      if (val == null) return;
      if (prevSciVals[key] != null) {
        var d = val - prevSciVals[key], cardId = key === "hb" ? "sci-heaps-beta" : key === "zc" ? "sci-zipf-coeff" : "sci-cl";
        var card = byId(cardId); if (!card) { prevSciVals[key] = val; return; }
        var sub = card.querySelector(".sci-metric-sub"); if (!sub) { prevSciVals[key] = val; return; }
        var span = sub.querySelector(".delta-indicator");
        if (!span) { span = createEl("span", "delta-flat delta-indicator"); sub.appendChild(document.createTextNode(" ")); sub.appendChild(span); }
        span.className = (d > 0 ? "delta-up" : d < 0 ? "delta-down" : "delta-flat") + " delta-indicator";
        span.textContent = " " + (d > 0 ? "\u25B2" : d < 0 ? "\u25BC" : "\u25CF") + " " + Math.abs(d).toFixed(4);
      }
      prevSciVals[key] = val;
    }
    if (sci.heaps) check("hb", sci.heaps.heaps_beta);
    if (sci.zipf) check("zc", sci.zipf.zipf_coefficient);
    if (sci.network) check("cl", sci.network.clustering_coefficient);
  }

  // --- Feature 40: World leaderboard ---
  function renderWorldLeaderboard() {
    var container = byId("world-leaderboard"); if (!container) return; clearEl(container);
    var worlds = state.worlds || [];
    if (worlds.length === 0) { container.appendChild(createEl("span", "muted-text", "No world data")); return; }
    var sorted = worlds.slice().sort(function(a, b) { return (b.interactions || 0) - (a.interactions || 0); });
    var table = createEl("table", "dict-table"); table.style.width = "100%";
    var thead = createEl("thead"), headRow = createEl("tr");
    ["#", "World", "Ticks", "Interactions", "Words", "Status"].forEach(function(h) { var th = createEl("th"); th.textContent = h; headRow.appendChild(th); });
    thead.appendChild(headRow); table.appendChild(thead);
    var tbody = createEl("tbody");
    sorted.forEach(function(w, i) { var tr = createEl("tr"); [i + 1, "W" + w.world_id, w.ticks || 0, w.interactions || 0, w.shared_words || 0, w.status || "?"].forEach(function(v) { var td = createEl("td"); td.textContent = String(v); tr.appendChild(td); }); tbody.appendChild(tr); });
    table.appendChild(tbody); container.appendChild(table);
  }

  // --- Feature 42: Vocabulary overlap matrix ---
  function drawVocabOverlap() {
    var r = setupCanvas("chart-vocab-overlap"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, lex = state.lexicon_by_citizen || {}, citizens = getCitizens();
    if (citizens.length < 2) { drawNoData(ctx, w, h, "Need 2+ citizens"); return; }
    var ids = citizens.map(function(c) { return c.id; }), names = citizens.map(function(c) { return c.name; }), n = ids.length;
    var sets = {}; ids.forEach(function(id) { sets[id] = new Set(); (lex[id] || []).forEach(function(v) { sets[id].add(v.sound); }); });
    var maxOv = 0;
    var mat = []; for (var i = 0; i < n; i++) { mat[i] = []; for (var j = 0; j < n; j++) { if (i === j) mat[i][j] = sets[ids[i]].size; else { var ov = 0; sets[ids[i]].forEach(function(s) { if (sets[ids[j]].has(s)) ov++; }); mat[i][j] = ov; if (ov > maxOv) maxOv = ov; } } }
    if (maxOv === 0) maxOv = 1;
    var pad = { top: 8, bottom: 8, left: 55, right: 8 }, gridW = w - pad.left - pad.right, gridH = h - pad.top - pad.bottom - 20;
    var cellW = gridW / n, cellH = gridH / n;
    for (var ri = 0; ri < n; ri++) {
      var ry = pad.top + 20 + ri * cellH;
      ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "7px 'Inter', sans-serif"; ctx.textAlign = "right"; ctx.fillText(names[ri].substring(0, 5), pad.left - 3, ry + cellH / 2 + 3);
      for (var ci = 0; ci < n; ci++) { var cx = pad.left + ci * cellW, val = mat[ri][ci];
        ctx.fillStyle = ri === ci ? "rgba(212,165,116,0.2)" : "rgba(90,155,186," + (0.05 + (val / maxOv) * 0.9).toFixed(2) + ")";
        ctx.fillRect(cx + 0.5, ry + 0.5, cellW - 1, cellH - 1);
      }
    }
  }

  // --- Feature 43: Sound etymology ---
  function renderEtymology() {
    var container = byId("etymology-container"); if (!container) return; clearEl(container);
    var shared = state.shared_lexicon || [];
    if (shared.length === 0) { container.appendChild(createEl("span", "muted-text", "No shared words to trace")); return; }
    var nameMap = {}; getCitizens().forEach(function(c) { nameMap[c.id] = c.name; });
    shared.slice(0, 20).forEach(function(word) {
      var card = createEl("div", "etymology-card");
      var hdr = createEl("span"); hdr.appendChild(createEl("span", "etymology-sound", word.sound)); hdr.appendChild(createEl("span", "etymology-meaning", word.meaning)); card.appendChild(hdr);
      var chain = createEl("div", "etymology-chain");
      (word.established_by || []).forEach(function(cid, i) {
        if (i > 0) chain.appendChild(createEl("span", "etymology-arrow", "\u2192"));
        chain.appendChild(createEl("span", i === 0 ? "etymology-node origin" : "etymology-node", nameMap[cid] || cid.substring(0, 6)));
      });
      card.appendChild(chain); container.appendChild(card);
    });
  }

  // --- Feature 27: Transfer network ---
  function drawTransferNetwork() {
    var r = setupCanvas("chart-transfer-network"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var ranking = ((state.science || {}).influence || {}).influence_ranking || [];
    if (ranking.length < 2) { drawNoData(ctx, w, h, "Need influence data"); return; }
    var nameMap = {}; getCitizens().forEach(function(c) { nameMap[c.id] = c.name; });
    var rels = state.relationships || [], cx = w / 2, cy = h / 2, rad = Math.min(w, h) * 0.35;
    var nodes = {}; ranking.forEach(function(item, i) {
      var angle = (i / ranking.length) * Math.PI * 2 - Math.PI / 2;
      nodes[item.citizen] = { x: cx + rad * Math.cos(angle), y: cy + rad * Math.sin(angle), score: item.influence_score, name: nameMap[item.citizen] || item.citizen.substring(0, 5) };
    });
    rels.forEach(function(rel) { var a = nodes[rel.citizen_a], b = nodes[rel.citizen_b]; if (!a || !b) return; ctx.strokeStyle = "rgba(90,84,101," + (0.1 + Math.abs(rel.score) * 0.4).toFixed(2) + ")"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });
    var maxS = 0; ranking.forEach(function(r) { if (r.influence_score > maxS) maxS = r.influence_score; }); if (maxS === 0) maxS = 1;
    for (var nid in nodes) { var n = nodes[nid], sz = 4 + (n.score / maxS) * 10; ctx.fillStyle = PALETTE[ranking.findIndex(function(r) { return r.citizen === nid; }) % PALETTE.length]; ctx.beginPath(); ctx.arc(n.x, n.y, sz, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "rgba(240,224,204,0.8)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "center"; ctx.fillText(n.name, n.x, n.y - sz - 3); }
  }

  // --- Feature 47: World overlay ---
  function drawWorldOverlay() {
    var r = setupCanvas("chart-world-overlay"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h, snaps = state.snapshots || [];
    if (snaps.length < 2) { drawNoData(ctx, w, h, "Need snapshot data for overlay"); return; }
    var pad = { top: 15, bottom: 30, left: 45, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var maxT = 0, maxV = 0; snaps.forEach(function(s) { if (s.tick > maxT) maxT = s.tick; if (s.shared_vocab_size > maxV) maxV = s.shared_vocab_size; }); if (!maxT) maxT = 1; if (!maxV) maxV = 1;
    ctx.strokeStyle = "#4a9e6e"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    snaps.forEach(function(s, i) { var x = pad.left + (s.tick / maxT) * cw, y = pad.top + ch - (s.shared_vocab_size / maxV) * ch; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center"; ctx.fillText("Tick (all worlds)", w / 2, h - 5);
  }

  // --- Feature 48: Performance overlay ---
  var perfFrameCount = 0, perfLastFPS = 0;
  function updatePerfOverlay() {
    perfFrameCount++;
    var now = performance.now();
    if (now - perfLastFPS > 1000) {
      var fps = Math.round(perfFrameCount * 1000 / (now - perfLastFPS));
      setText("perf-fps", fps + " fps"); setText("perf-poll", Math.round(lastPollMs) + "ms poll");
      var totalErr = 0; for (var k in errorCounts) totalErr += errorCounts[k];
      setText("perf-errors", totalErr + " errors");
      perfFrameCount = 0; perfLastFPS = now;
    }
  }

  // --- Feature 24: Mobile swipe ---
  function initMobileSwipe() {
    var content = document.querySelector(".tab-content"); if (!content) return;
    var sx = 0, sy = 0, tabs = ["overview", "citizens", "language", "events", "learning", "proto-sounds"];
    content.addEventListener("touchstart", function(e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    content.addEventListener("touchend", function(e) {
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) < 80 || Math.abs(dy) > Math.abs(dx)) return;
      var idx = tabs.indexOf(activeTab);
      if (dx < 0 && idx < tabs.length - 1) switchTab(tabs[idx + 1]);
      else if (dx > 0 && idx > 0) switchTab(tabs[idx - 1]);
    }, { passive: true });
  }

  // ===========================================================================
  // 23 NEW VISUALIZATION FUNCTIONS
  // ===========================================================================

  // --- 1. Family Tree (canvas#chart-family-tree) ---
  function drawFamilyTree() {
    var r = setupCanvas("chart-family-tree"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var events = state.breeding_events || [];
    var citizens = getCitizens();
    if (events.length === 0 && citizens.length === 0) { drawNoData(ctx, w, h, "No breeding events recorded"); return; }
    var allIds = new Set();
    citizens.forEach(function(c) { allIds.add(c.id); });
    events.forEach(function(e) { if (e.parent_a) allIds.add(e.parent_a); if (e.parent_b) allIds.add(e.parent_b); if (e.offspring) allIds.add(e.offspring); });
    var ids = Array.from(allIds);
    if (ids.length === 0) { drawNoData(ctx, w, h, "No family data"); return; }
    var pad = { top: 20, bottom: 20, left: 20, right: 20 };
    var nodeMap = {};
    var spacing = (w - pad.left - pad.right) / (ids.length + 1);
    ids.forEach(function(id, i) {
      var sex = getCitizenSex(id);
      nodeMap[id] = { x: pad.left + (i + 1) * spacing, y: h / 2 + (i % 2 === 0 ? -30 : 30), sex: sex };
    });
    // Move offspring below parents
    events.forEach(function(e) {
      if (e.offspring && nodeMap[e.offspring]) nodeMap[e.offspring].y = h * 0.75;
      if (e.parent_a && nodeMap[e.parent_a]) nodeMap[e.parent_a].y = h * 0.25;
      if (e.parent_b && nodeMap[e.parent_b]) nodeMap[e.parent_b].y = h * 0.25;
    });
    // Draw connections
    events.forEach(function(e) {
      var off = nodeMap[e.offspring];
      if (!off) return;
      [e.parent_a, e.parent_b].forEach(function(pid) {
        var par = nodeMap[pid]; if (!par) return;
        ctx.strokeStyle = "rgba(212,165,116,0.4)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(par.x, par.y); ctx.lineTo(off.x, off.y); ctx.stroke();
      });
    });
    // Draw nodes
    for (var nid in nodeMap) {
      var n = nodeMap[nid];
      var col = n.sex === "female" ? "#d4a574" : "#5a9bba";
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(n.x, n.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(240,224,204,0.8)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "center";
      ctx.fillText(findCitizenName(nid).substring(0, 8), n.x, n.y - 10);
    }
  }

  // --- 2. Dialect Regions (canvas#chart-dialect-regions) ---
  function drawDialectRegions() {
    var r = setupCanvas("chart-dialect-regions"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var citizens = getCitizens(), lex = state.lexicon_by_citizen || {};
    if (citizens.length === 0) { drawNoData(ctx, w, h, "No citizens for dialect mapping"); return; }
    var gridN = 4; // 4x4 quadrants
    var cellW = w / gridN, cellH = h / gridN;
    var grid = [];
    for (var gy = 0; gy < gridN; gy++) { grid[gy] = []; for (var gx = 0; gx < gridN; gx++) grid[gy][gx] = new Set(); }
    citizens.forEach(function(c) {
      var qx = Math.min(gridN - 1, Math.floor((c.x || 0) / (MAP_W / gridN)));
      var qy = Math.min(gridN - 1, Math.floor((c.y || 0) / (MAP_H / gridN)));
      (lex[c.id] || []).forEach(function(v) { grid[qy][qx].add(v.sound); });
    });
    var maxSounds = 1;
    for (var ry = 0; ry < gridN; ry++) for (var rx = 0; rx < gridN; rx++) { if (grid[ry][rx].size > maxSounds) maxSounds = grid[ry][rx].size; }
    for (var dy = 0; dy < gridN; dy++) {
      for (var dx = 0; dx < gridN; dx++) {
        var intensity = grid[dy][dx].size / maxSounds;
        var rr = Math.round(90 + intensity * 120), gg = Math.round(50 + (1 - intensity) * 100), bb = Math.round(150 - intensity * 100);
        ctx.fillStyle = "rgb(" + rr + "," + gg + "," + bb + ")";
        ctx.fillRect(dx * cellW, dy * cellH, cellW - 2, cellH - 2);
        ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 12px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
        ctx.fillText(grid[dy][dx].size, dx * cellW + cellW / 2, dy * cellH + cellH / 2 + 4);
      }
    }
    ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Unique sounds per map quadrant", w / 2, h - 4);
  }

  // --- 3. Language Death (canvas#chart-language-death) ---
  function drawLanguageDeath() {
    var r = setupCanvas("chart-language-death"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var deaths = state.deaths || [], lex = state.lexicon_by_citizen || {};
    if (deaths.length === 0) { drawNoData(ctx, w, h, "No deaths — no language lost yet"); return; }
    var pad = { top: 15, bottom: 30, left: 50, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    // For each dead citizen, count sounds only they knew vs sounds that survived
    var allLiveSounds = new Set();
    var citizens = getCitizens();
    citizens.forEach(function(c) { (lex[c.id] || []).forEach(function(v) { allLiveSounds.add(v.sound); }); });
    var data = [];
    deaths.forEach(function(d) {
      var deadSounds = (lex[d.citizen_id] || []).map(function(v) { return v.sound; });
      var lost = 0, survived = 0;
      deadSounds.forEach(function(s) { if (allLiveSounds.has(s)) survived++; else lost++; });
      data.push({ name: findCitizenName(d.citizen_id).substring(0, 8), lost: lost, survived: survived });
    });
    if (data.length === 0) { drawNoData(ctx, w, h, "No lexicon data for deceased"); return; }
    var maxVal = 1;
    data.forEach(function(d) { if (d.lost + d.survived > maxVal) maxVal = d.lost + d.survived; });
    var bH = Math.max(12, Math.min(20, ch / data.length - 2));
    data.forEach(function(d, i) {
      var y = pad.top + i * (bH + 2);
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "right";
      ctx.fillText(d.name, pad.left - 4, y + bH - 3);
      var sw = (d.survived / maxVal) * cw, lw = (d.lost / maxVal) * cw;
      ctx.fillStyle = "#4a9e6e"; ctx.fillRect(pad.left, y, sw, bH);
      ctx.fillStyle = "#c44a20"; ctx.fillRect(pad.left + sw, y, lw, bH);
    });
    ctx.fillStyle = "#4a9e6e"; ctx.fillRect(pad.left, h - 16, 10, 8);
    ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Survived", pad.left + 14, h - 9);
    ctx.fillStyle = "#c44a20"; ctx.fillRect(pad.left + 80, h - 16, 10, 8);
    ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.fillText("Lost", pad.left + 94, h - 9);
  }

  // --- 4. Migration Patterns (canvas#chart-migration) ---
  function drawMigrationPatterns() {
    var r = setupCanvas("chart-migration"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var citizens = getCitizens();
    if (citizens.length === 0) { drawNoData(ctx, w, h, "No citizens to map"); return; }
    var pad = 20, cw = w - pad * 2, ch = h - pad * 2;
    // Draw current positions as scatter, colored by role
    var roleColors = { alpha: "#c44a20", provider: "#4a9e6e", intellectual: "#5a9bba", wildcard: "#8a6abf" };
    citizens.forEach(function(c) {
      var sx = pad + (c.x || 0) / MAP_W * cw;
      var sy = pad + (c.y || 0) / MAP_H * ch;
      var col = roleColors[(c.role || "").toLowerCase()] || "#d4a574";
      ctx.fillStyle = col + "40"; ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(240,224,204,0.7)"; ctx.font = "7px 'Inter', sans-serif"; ctx.textAlign = "center";
      ctx.fillText(c.name.substring(0, 6), sx, sy - 8);
    });
    // Draw movement vectors from snapshots if available
    var snaps = state.snapshots || [];
    if (snaps.length >= 2) {
      var last = snaps[snaps.length - 1], prev = snaps[snaps.length - 2];
      if (last.citizen_positions && prev.citizen_positions) {
        for (var cid in last.citizen_positions) {
          var cur = last.citizen_positions[cid], pre = prev.citizen_positions[cid];
          if (!cur || !pre) continue;
          var x1 = pad + (pre.x || 0) / MAP_W * cw, y1 = pad + (pre.y || 0) / MAP_H * ch;
          var x2 = pad + (cur.x || 0) / MAP_W * cw, y2 = pad + (cur.y || 0) / MAP_H * ch;
          ctx.strokeStyle = "rgba(212,165,116,0.4)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Citizen positions (color = role)", w / 2, h - 4);
  }

  // --- 5. Seasonal Language (canvas#chart-seasonal-lang) ---
  function drawSeasonalLanguage() {
    var r = setupCanvas("chart-seasonal-lang"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var utterances = state.recent_utterances || [];
    if (utterances.length === 0) { drawNoData(ctx, w, h, "No utterances to analyze by season"); return; }
    var seasons = ["spring", "summer", "autumn", "winter"];
    var counts = {}; seasons.forEach(function(s) { counts[s] = 0; });
    // Try to determine season from utterance context or fall back to current
    var currentSeason = (state.live_state || {}).season || "summer";
    utterances.forEach(function(u) {
      var s = (u.season || u.context_season || currentSeason).toLowerCase();
      if (counts[s] != null) counts[s]++;
      else counts[currentSeason]++;
    });
    var maxC = 1; seasons.forEach(function(s) { if (counts[s] > maxC) maxC = counts[s]; });
    var pad = { top: 15, bottom: 30, left: 15, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var bW = cw / seasons.length - 10;
    var sColors = { spring: "#4a9e6e", summer: "#d4a574", autumn: "#c44a20", winter: "#5a9bba" };
    seasons.forEach(function(s, i) {
      var bH = (counts[s] / maxC) * ch;
      var bx = pad.left + i * (bW + 10) + 5;
      var by = pad.top + ch - bH;
      ctx.fillStyle = sColors[s]; roundedRect(ctx, bx, by, bW, bH, 3); ctx.fill();
      ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 10px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText(counts[s], bx + bW / 2, by - 4);
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif";
      ctx.fillText(s, bx + bW / 2, h - 8);
    });
  }

  // --- 6. Night/Day Sounds (canvas#chart-night-day) ---
  function drawNightDaySounds() {
    var r = setupCanvas("chart-night-day"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var utterances = state.recent_utterances || [];
    if (utterances.length === 0) { drawNoData(ctx, w, h, "No utterances for day/night analysis"); return; }
    var dayPhonemes = {}, nightPhonemes = {};
    var nightTimes = { night: 1, deep_night: 1, evening: 1, dusk: 1 };
    var currentTime = (state.live_state || {}).time_of_day || "midday";
    utterances.forEach(function(u) {
      var tod = u.time_of_day || u.context_time || currentTime;
      var bucket = nightTimes[tod] ? nightPhonemes : dayPhonemes;
      var sounds = (u.utterance || "").toLowerCase().replace(/[^a-z]/g, "");
      for (var ci = 0; ci < sounds.length; ci++) { var ch = sounds[ci]; bucket[ch] = (bucket[ch] || 0) + 1; }
    });
    var allChars = new Set(Object.keys(dayPhonemes).concat(Object.keys(nightPhonemes)));
    var chars = Array.from(allChars).sort();
    if (chars.length === 0) { drawNoData(ctx, w, h, "No phoneme data"); return; }
    var maxVal = 1;
    chars.forEach(function(c) { var v = Math.max(dayPhonemes[c] || 0, nightPhonemes[c] || 0); if (v > maxVal) maxVal = v; });
    var pad = { top: 15, bottom: 25, left: 10, right: 10 }, cw = w - pad.left - pad.right, ch2 = h - pad.top - pad.bottom;
    var barW = Math.max(4, cw / chars.length / 2 - 1);
    chars.forEach(function(c, i) {
      var x = pad.left + i * (barW * 2 + 3);
      var dH = ((dayPhonemes[c] || 0) / maxVal) * ch2;
      var nH = ((nightPhonemes[c] || 0) / maxVal) * ch2;
      ctx.fillStyle = "#d4a574"; ctx.fillRect(x, pad.top + ch2 - dH, barW, dH);
      ctx.fillStyle = "#5a9bba"; ctx.fillRect(x + barW + 1, pad.top + ch2 - nH, barW, nH);
      ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "7px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText(c, x + barW, h - 6);
    });
    ctx.fillStyle = "#d4a574"; ctx.fillRect(pad.left, 3, 8, 8);
    ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Day", pad.left + 12, 10);
    ctx.fillStyle = "#5a9bba"; ctx.fillRect(pad.left + 42, 3, 8, 8);
    ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.fillText("Night", pad.left + 54, 10);
  }

  // --- 7. Influence Decay (canvas#chart-influence-decay) ---
  function drawInfluenceDecay() {
    var r = setupCanvas("chart-influence-decay"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var deaths = state.deaths || [];
    var ranking = ((state.science || {}).influence || {}).influence_ranking || [];
    if (deaths.length === 0) { drawNoData(ctx, w, h, "No deaths — no influence to decay"); return; }
    var pad = { top: 15, bottom: 30, left: 45, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    // Build theoretical decay curves for dead citizens
    var ls = state.live_state || {};
    var currentTick = ls.tick || 100;
    var scoreMap = {};
    ranking.forEach(function(item) { scoreMap[item.citizen] = item.influence_score; });
    var curves = [];
    deaths.forEach(function(d) {
      var baseScore = scoreMap[d.citizen_id] || 0.1;
      var deathTick = d.tick || 0;
      var pts = [];
      for (var t = 0; t <= 100; t += 5) {
        pts.push({ tick: deathTick + t, val: baseScore * Math.exp(-0.03 * t) });
      }
      curves.push({ name: findCitizenName(d.citizen_id).substring(0, 8), pts: pts });
    });
    if (curves.length === 0) { drawNoData(ctx, w, h, "No decay data"); return; }
    var maxT = 0, minT = Infinity;
    curves.forEach(function(c) { c.pts.forEach(function(p) { if (p.tick > maxT) maxT = p.tick; if (p.tick < minT) minT = p.tick; }); });
    if (maxT === minT) maxT = minT + 1;
    curves.forEach(function(curve, ci) {
      ctx.strokeStyle = PALETTE[ci % PALETTE.length]; ctx.lineWidth = 1.5; ctx.beginPath();
      curve.pts.forEach(function(p, i) {
        var x = pad.left + ((p.tick - minT) / (maxT - minT)) * cw;
        var y = pad.top + ch - p.val * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      var lastPt = curve.pts[curve.pts.length - 1];
      ctx.fillStyle = PALETTE[ci % PALETTE.length]; ctx.font = "7px 'Inter', sans-serif"; ctx.textAlign = "left";
      ctx.fillText(curve.name, pad.left + cw + 2, pad.top + ch - lastPt.val * ch + 3);
    });
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Theoretical influence decay after death", w / 2, h - 5);
  }

  // --- 8. Word Wars (canvas#chart-word-wars) ---
  function drawWordWars() {
    var r = setupCanvas("chart-word-wars"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var lex = state.lexicon_by_citizen || {};
    // Find meanings with competing sounds
    var meaningMap = {}; // meaning -> { sound: count }
    for (var cid in lex) {
      (lex[cid] || []).forEach(function(v) {
        if (!meaningMap[v.meaning]) meaningMap[v.meaning] = {};
        meaningMap[v.meaning][v.sound] = (meaningMap[v.meaning][v.sound] || 0) + 1;
      });
    }
    var conflicts = [];
    for (var meaning in meaningMap) {
      var sounds = Object.keys(meaningMap[meaning]);
      if (sounds.length >= 2) {
        conflicts.push({ meaning: meaning, sounds: meaningMap[meaning] });
      }
    }
    if (conflicts.length === 0) { drawNoData(ctx, w, h, "No competing sounds for same meaning"); return; }
    conflicts.sort(function(a, b) { return Object.keys(b.sounds).length - Object.keys(a.sounds).length; });
    conflicts = conflicts.slice(0, 8);
    var pad = { top: 10, bottom: 10, left: 80, right: 10 }, barArea = w - pad.left - pad.right;
    var maxCount = 1;
    conflicts.forEach(function(c) { for (var s in c.sounds) { if (c.sounds[s] > maxCount) maxCount = c.sounds[s]; } });
    var rowH = Math.max(14, Math.min(24, (h - pad.top - pad.bottom) / conflicts.length - 4));
    conflicts.forEach(function(c, ci) {
      var y = pad.top + ci * (rowH + 4);
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "right";
      ctx.fillText(c.meaning.substring(0, 10), pad.left - 4, y + rowH / 2 + 3);
      var sounds = Object.keys(c.sounds).sort(function(a, b) { return c.sounds[b] - c.sounds[a]; });
      var x = pad.left;
      sounds.forEach(function(s, si) {
        var bw = (c.sounds[s] / maxCount) * barArea * 0.4;
        ctx.fillStyle = PALETTE[si % PALETTE.length]; ctx.fillRect(x, y, bw, rowH);
        ctx.fillStyle = "#f0e0cc"; ctx.font = "7px 'JetBrains Mono', monospace"; ctx.textAlign = "left";
        if (bw > 20) ctx.fillText(s, x + 3, y + rowH - 3);
        x += bw + 2;
      });
    });
  }

  // --- 9. Phoneme Evolution (canvas#chart-phoneme-evolution) ---
  function drawPhonemeEvolution() {
    var r = setupCanvas("chart-phoneme-evolution"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var sh = state.science_history || [];
    if (sh.length < 2) { drawNoData(ctx, w, h, "Accumulating science history for evolution chart..."); return; }
    var pad = { top: 15, bottom: 30, left: 40, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    // Track unique vocab size over time from science history
    var pts = [];
    sh.forEach(function(s) {
      if (s.metrics && s.metrics.growth_curve && s.metrics.growth_curve.current_vocab_size != null) {
        pts.push({ tick: s.tick, val: s.metrics.growth_curve.current_vocab_size });
      } else if (s.metrics && s.metrics.heaps && s.metrics.heaps.unique_types != null) {
        pts.push({ tick: s.tick, val: s.metrics.heaps.unique_types });
      }
    });
    if (pts.length < 2) { drawNoData(ctx, w, h, "Not enough phoneme evolution data"); return; }
    var minT = pts[0].tick, maxT = pts[pts.length - 1].tick;
    if (maxT === minT) maxT = minT + 1;
    var maxV = 1; pts.forEach(function(p) { if (p.val > maxV) maxV = p.val; });
    // Area fill
    ctx.fillStyle = "rgba(90,155,186,0.15)"; ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ch);
    pts.forEach(function(p) {
      var x = pad.left + ((p.tick - minT) / (maxT - minT)) * cw;
      var y = pad.top + ch - (p.val / maxV) * ch;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.left + cw, pad.top + ch); ctx.closePath(); ctx.fill();
    // Line
    ctx.strokeStyle = "#5a9bba"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    pts.forEach(function(p, i) {
      var x = pad.left + ((p.tick - minT) / (maxT - minT)) * cw;
      var y = pad.top + ch - (p.val / maxV) * ch;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "10px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Phoneme diversity over time", w / 2, h - 5);
    ctx.fillStyle = "#5a9bba"; ctx.font = "bold 10px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
    ctx.fillText(pts[pts.length - 1].val + " types", w - pad.right, pad.top + 12);
  }

  // --- 10. Adoption Speed (canvas#chart-adoption-speed) ---
  function drawAdoptionSpeed() {
    var r = setupCanvas("chart-adoption-speed"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var shared = state.shared_lexicon || [];
    if (shared.length === 0) { drawNoData(ctx, w, h, "No shared words to measure adoption"); return; }
    var ls = state.live_state || {};
    var currentTick = ls.tick || 0;
    var data = [];
    shared.forEach(function(s) {
      if (s.tick_established != null && s.citizen_count > 0) {
        var speed = currentTick - s.tick_established;
        if (speed <= 0) speed = 1;
        data.push({ sound: s.sound, speed: speed, citizens: s.citizen_count });
      }
    });
    data.sort(function(a, b) { return a.speed - b.speed; });
    data = data.slice(0, 15);
    if (data.length === 0) { drawNoData(ctx, w, h, "No adoption data available"); return; }
    var pad = { top: 10, bottom: 10, left: 70, right: 30 }, barArea = w - pad.left - pad.right;
    var maxSpeed = 1; data.forEach(function(d) { if (d.speed > maxSpeed) maxSpeed = d.speed; });
    var bH = Math.max(12, Math.min(20, (h - pad.top - pad.bottom) / data.length - 2));
    data.forEach(function(d, i) {
      var y = pad.top + i * (bH + 2);
      var bw = (d.speed / maxSpeed) * barArea;
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "right";
      ctx.fillText(d.sound.substring(0, 8), pad.left - 4, y + bH - 3);
      ctx.fillStyle = PALETTE[i % PALETTE.length]; roundedRect(ctx, pad.left, y, bw, bH, 3); ctx.fill();
      ctx.fillStyle = "#f0e0cc"; ctx.font = "8px 'JetBrains Mono', monospace"; ctx.textAlign = "left";
      ctx.fillText(d.speed + "t / " + d.citizens + "c", pad.left + bw + 4, y + bH - 3);
    });
  }

  // --- 11. Archetype Rivalry (canvas#chart-archetype-rivalry) ---
  function drawArchetypeRivalry() {
    var r = setupCanvas("chart-archetype-rivalry"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var rels = state.relationships || [], citizens = getCitizens();
    if (rels.length === 0) { drawNoData(ctx, w, h, "No relationships for archetype analysis"); return; }
    var roleMap = {};
    citizens.forEach(function(c) { roleMap[c.id] = (c.archetype || c.role || "unknown").toLowerCase(); });
    var pairScores = {}; // "A-B" -> { sum, count }
    rels.forEach(function(rel) {
      var ra = roleMap[rel.citizen_a] || "?", rb = roleMap[rel.citizen_b] || "?";
      var key = [ra, rb].sort().join("-");
      if (!pairScores[key]) pairScores[key] = { sum: 0, count: 0 };
      pairScores[key].sum += rel.score; pairScores[key].count++;
    });
    var pairs = Object.keys(pairScores);
    if (pairs.length === 0) { drawNoData(ctx, w, h, "No archetype pair data"); return; }
    // Get unique archetypes for heatmap
    var archetypes = new Set();
    pairs.forEach(function(p) { var parts = p.split("-"); archetypes.add(parts[0]); archetypes.add(parts[1]); });
    var archList = Array.from(archetypes).sort();
    var n = archList.length;
    var pad = { top: 8, bottom: 8, left: 70, right: 8 };
    var gridW = w - pad.left - pad.right, gridH = h - pad.top - pad.bottom - 20;
    var cellW = gridW / n, cellH = gridH / n;
    // Column labels
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "center";
    archList.forEach(function(a, i) {
      ctx.save(); ctx.translate(pad.left + i * cellW + cellW / 2, pad.top + 16);
      ctx.rotate(-Math.PI / 4); ctx.fillText(a, 0, 0); ctx.restore();
    });
    archList.forEach(function(rowArch, ri) {
      var ry = pad.top + 20 + ri * cellH;
      ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "8px 'Inter', sans-serif"; ctx.textAlign = "right";
      ctx.fillText(rowArch, pad.left - 4, ry + cellH / 2 + 3);
      archList.forEach(function(colArch, ci) {
        var key = [rowArch, colArch].sort().join("-");
        var pair = pairScores[key];
        var avg = pair ? pair.sum / pair.count : 0;
        if (avg > 0) ctx.fillStyle = "rgba(74,158,110," + Math.min(0.9, 0.1 + Math.abs(avg) * 0.8).toFixed(2) + ")";
        else if (avg < 0) ctx.fillStyle = "rgba(196,74,32," + Math.min(0.9, 0.1 + Math.abs(avg) * 0.8).toFixed(2) + ")";
        else ctx.fillStyle = "rgba(30,30,42,0.3)";
        ctx.fillRect(pad.left + ci * cellW + 1, ry + 1, cellW - 2, cellH - 2);
        if (pair && cellW > 20) {
          ctx.fillStyle = "#f0e0cc"; ctx.font = "7px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
          ctx.fillText(avg.toFixed(1), pad.left + ci * cellW + cellW / 2, ry + cellH / 2 + 3);
        }
      });
    });
  }

  // --- 12. Food Chain (canvas#chart-food-chain) ---
  function drawFoodChain() {
    var r = setupCanvas("chart-food-chain"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var flora = state.flora || {}, fauna = state.fauna || {}, citizens = getCitizens();
    var floraCount = flora.total_plants || flora.plant_count || 0;
    var faunaCount = (fauna.prey_count || 0) + (fauna.predator_count || 0) + (fauna.bird_count || 0);
    var citizenCount = citizens.length;
    if (floraCount === 0 && faunaCount === 0 && citizenCount === 0) { drawNoData(ctx, w, h, "No ecosystem data"); return; }
    var maxVal = Math.max(floraCount, faunaCount, citizenCount, 1);
    var levels = [
      { label: "Flora", count: floraCount, color: "#4a9e6e" },
      { label: "Fauna", count: faunaCount, color: "#d4a574" },
      { label: "Citizens", count: citizenCount, color: "#5a9bba" }
    ];
    var centerX = w / 2, topY = 30, rowH = (h - 60) / 3;
    levels.forEach(function(lev, i) {
      var y = topY + i * rowH;
      var boxW = Math.max(40, (lev.count / maxVal) * (w * 0.6));
      var boxH = rowH * 0.6;
      ctx.fillStyle = lev.color + "30";
      roundedRect(ctx, centerX - boxW / 2, y, boxW, boxH, 6); ctx.fill();
      ctx.strokeStyle = lev.color; ctx.lineWidth = 2;
      roundedRect(ctx, centerX - boxW / 2, y, boxW, boxH, 6); ctx.stroke();
      ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 14px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText(lev.count, centerX, y + boxH / 2 + 5);
      ctx.fillStyle = lev.color; ctx.font = "10px 'Inter', sans-serif";
      ctx.fillText(lev.label, centerX, y - 4);
      // Arrow to next level
      if (i < levels.length - 1) {
        ctx.strokeStyle = "rgba(212,165,116,0.4)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(centerX, y + boxH + 2); ctx.lineTo(centerX, y + rowH - 2); ctx.stroke();
        ctx.fillStyle = "rgba(212,165,116,0.4)"; ctx.beginPath();
        ctx.moveTo(centerX - 5, y + rowH - 8); ctx.lineTo(centerX + 5, y + rowH - 8); ctx.lineTo(centerX, y + rowH - 2); ctx.fill();
      }
    });
  }

  // --- 13. Language Tree (canvas#chart-language-tree) ---
  function drawLanguageTree() {
    var r = setupCanvas("chart-language-tree"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var shared = state.shared_lexicon || [];
    if (shared.length === 0) { drawNoData(ctx, w, h, "No shared lexicon for tree"); return; }
    // Group by meaning category (take first word of meaning as category)
    var categories = {};
    shared.forEach(function(s) {
      var cat = (s.meaning || "unknown").split(/[\s_-]/)[0].toLowerCase();
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(s.sound);
    });
    var catNames = Object.keys(categories).sort(function(a, b) { return categories[b].length - categories[a].length; });
    catNames = catNames.slice(0, 8); // Limit to 8 branches
    var rootX = w / 2, rootY = h - 20;
    // Draw root
    ctx.fillStyle = "#d4a574"; ctx.beginPath(); ctx.arc(rootX, rootY, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 9px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Proto-Language", rootX, rootY + 20);
    var branchSpacing = (w - 40) / (catNames.length + 1);
    catNames.forEach(function(cat, ci) {
      var bx = 20 + (ci + 1) * branchSpacing;
      var by = h * 0.5;
      // Branch line
      ctx.strokeStyle = PALETTE[ci % PALETTE.length] + "80"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(rootX, rootY - 8); ctx.quadraticCurveTo(rootX, by + 20, bx, by); ctx.stroke();
      // Category node
      ctx.fillStyle = PALETTE[ci % PALETTE.length]; ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(240,224,204,0.8)"; ctx.font = "bold 8px 'Inter', sans-serif"; ctx.textAlign = "center";
      ctx.fillText(cat, bx, by - 8);
      // Leaf words
      var words = categories[cat].slice(0, 4);
      words.forEach(function(word, wi) {
        var lx = bx + (wi - words.length / 2) * 25;
        var ly = by - 40 - wi * 5;
        ctx.strokeStyle = PALETTE[ci % PALETTE.length] + "40"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bx, by - 5); ctx.lineTo(lx, ly); ctx.stroke();
        ctx.fillStyle = "rgba(240,224,204,0.6)"; ctx.font = "7px 'JetBrains Mono', monospace";
        ctx.fillText(word.substring(0, 6), lx, ly - 4);
      });
    });
  }

  // --- 14. Relationship Strength Distribution (canvas#chart-rel-strength) ---
  function drawRelStrengthOverTime() {
    var r = setupCanvas("chart-rel-strength"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var rels = state.relationships || [];
    if (rels.length === 0) { drawNoData(ctx, w, h, "No relationships to histogram"); return; }
    // Build histogram of relationship scores (-1 to 1) in 10 bins
    var bins = 10, binWidth = 2 / bins;
    var counts = new Array(bins).fill(0);
    rels.forEach(function(rel) {
      var idx = Math.min(bins - 1, Math.max(0, Math.floor((rel.score + 1) / binWidth)));
      counts[idx]++;
    });
    var maxC = 1; counts.forEach(function(c) { if (c > maxC) maxC = c; });
    var pad = { top: 15, bottom: 30, left: 35, right: 15 }, cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
    var bW = cw / bins - 2;
    counts.forEach(function(c, i) {
      var bH = (c / maxC) * ch;
      var bx = pad.left + i * (bW + 2);
      var by = pad.top + ch - bH;
      var binCenter = -1 + (i + 0.5) * binWidth;
      ctx.fillStyle = binCenter >= 0 ? "#4a9e6e" : "#c44a20";
      roundedRect(ctx, bx, by, bW, bH, 2); ctx.fill();
      ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "7px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText(binCenter.toFixed(1), bx + bW / 2, h - 10);
    });
    ctx.fillStyle = "rgba(90,84,101,0.5)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Relationship Score Distribution", w / 2, pad.top - 2);
  }

  // --- 15. Event Causality (canvas#chart-event-causality) ---
  function drawEventCausality() {
    var r = setupCanvas("chart-event-causality"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var events = state.world_events || [];
    if (events.length === 0) { drawNoData(ctx, w, h, "No world events recorded"); return; }
    var typeCounts = {};
    events.forEach(function(e) { var t = e.event_type || "unknown"; typeCounts[t] = (typeCounts[t] || 0) + 1; });
    var types = Object.keys(typeCounts).sort(function(a, b) { return typeCounts[b] - typeCounts[a]; });
    if (types.length === 0) { drawNoData(ctx, w, h, "No event types"); return; }
    var maxC = typeCounts[types[0]] || 1;
    var pad = { top: 10, bottom: 10, left: 90, right: 30 }, barArea = w - pad.left - pad.right;
    var bH = Math.max(14, Math.min(22, (h - pad.top - pad.bottom) / types.length - 3));
    var evtColors = { attack: "#c44a20", death: "#807a6e", milestone: "#d4a574", birth: "#4a9e6e", weather: "#5a9bba", season_change: "#8a6abf" };
    types.forEach(function(type, i) {
      var y = pad.top + i * (bH + 3);
      var bw = (typeCounts[type] / maxC) * barArea;
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "right";
      ctx.fillText(type.replace(/_/g, " "), pad.left - 4, y + bH / 2 + 3);
      ctx.fillStyle = evtColors[type] || PALETTE[i % PALETTE.length];
      roundedRect(ctx, pad.left, y, bw, bH, 3); ctx.fill();
      ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 9px 'JetBrains Mono', monospace"; ctx.textAlign = "left";
      ctx.fillText(typeCounts[type], pad.left + bw + 4, y + bH / 2 + 3);
    });
  }

  // --- 16. Danger Heatmap (canvas#chart-danger-heatmap) ---
  function drawDangerHeatmap() {
    var r = setupCanvas("chart-danger-heatmap"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var deaths = state.deaths || [];
    if (deaths.length === 0) { drawNoData(ctx, w, h, "No deaths for danger mapping"); return; }
    var gridN = 8;
    var cellW = w / gridN, cellH = h / gridN;
    var grid = [];
    for (var gy = 0; gy < gridN; gy++) { grid[gy] = []; for (var gx = 0; gx < gridN; gx++) grid[gy][gx] = 0; }
    deaths.forEach(function(d) {
      var dx = d.x || d.location_x || 0, dy = d.y || d.location_y || 0;
      var gx = Math.min(gridN - 1, Math.max(0, Math.floor(dx / (MAP_W / gridN))));
      var gy = Math.min(gridN - 1, Math.max(0, Math.floor(dy / (MAP_H / gridN))));
      grid[gy][gx]++;
    });
    var maxD = 1;
    for (var ry = 0; ry < gridN; ry++) for (var rx = 0; rx < gridN; rx++) { if (grid[ry][rx] > maxD) maxD = grid[ry][rx]; }
    for (var dy2 = 0; dy2 < gridN; dy2++) {
      for (var dx2 = 0; dx2 < gridN; dx2++) {
        var intensity = grid[dy2][dx2] / maxD;
        var rr = Math.round(30 + intensity * 200), gg = Math.round(30 + (1 - intensity) * 50), bb = Math.round(30);
        ctx.fillStyle = "rgb(" + rr + "," + gg + "," + bb + ")";
        ctx.fillRect(dx2 * cellW, dy2 * cellH, cellW - 1, cellH - 1);
        if (grid[dy2][dx2] > 0) {
          ctx.fillStyle = "#f0e0cc"; ctx.font = "bold 10px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
          ctx.fillText(grid[dy2][dx2], dx2 * cellW + cellW / 2, dy2 * cellH + cellH / 2 + 4);
        }
      }
    }
    ctx.fillStyle = "rgba(90,84,101,0.6)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Death locations (warmer = more deaths)", w / 2, h - 4);
  }

  // --- 17. Citizen Spotlight (div#citizen-spotlight) ---
  function renderCitizenSpotlight() {
    var container = byId("citizen-spotlight"); if (!container) return; clearEl(container);
    var citizens = getCitizens(), lex = state.lexicon_by_citizen || {}, rels = state.relationships || [];
    if (citizens.length === 0) { container.appendChild(createEl("span", "muted-text", "No citizens")); return; }
    // Score each citizen: vocab + relationships
    var best = null, bestScore = -1;
    citizens.forEach(function(c) {
      var vocabSize = (lex[c.id] || []).length;
      var relCount = rels.filter(function(r) { return r.citizen_a === c.id || r.citizen_b === c.id; }).length;
      var score = vocabSize * 2 + relCount;
      if (score > bestScore) { bestScore = score; best = c; }
    });
    if (!best) { container.appendChild(createEl("span", "muted-text", "No spotlight candidate")); return; }
    var card = createEl("div", "cascade-card");
    var header = createEl("div"); header.style.cssText = "display:flex;justify-content:space-between;align-items:center";
    header.appendChild(createEl("span", "cascade-sound", best.name));
    header.appendChild(createEl("span", "archetype-badge " + ((best.role || "unknown").toLowerCase()), (best.role || "?").toUpperCase()));
    card.appendChild(header);
    var stats = createEl("div", "cascade-stats");
    var vocab = (lex[best.id] || []);
    var myRels = rels.filter(function(r) { return r.citizen_a === best.id || r.citizen_b === best.id; });
    stats.textContent = "Age: " + (best.age || "?") + " | Vocab: " + vocab.length + " | Relationships: " + myRels.length + " | Mood: " + (best.mood != null ? best.mood.toFixed(2) : "?");
    card.appendChild(stats);
    if (vocab.length > 0) {
      var wordLine = createEl("div", "etymology-chain");
      vocab.slice(0, 8).forEach(function(v) { wordLine.appendChild(createEl("span", "inspect-vocab-tag", v.sound + "=" + v.meaning)); });
      card.appendChild(wordLine);
    }
    if (myRels.length > 0) {
      var relLine = createEl("div", "cascade-stats");
      relLine.textContent = "Top bonds: " + myRels.slice().sort(function(a, b) { return Math.abs(b.score) - Math.abs(a.score); }).slice(0, 3).map(function(r) {
        var oid = r.citizen_a === best.id ? r.citizen_b : r.citizen_a;
        return findCitizenName(oid) + " (" + r.score.toFixed(1) + ")";
      }).join(", ");
      card.appendChild(relLine);
    }
    container.appendChild(card);
  }

  // --- 18. Drama Feed (div#drama-feed) ---
  function renderDramaFeed() {
    var container = byId("drama-feed"); if (!container) return; clearEl(container);
    var rels = state.relationships || [];
    if (rels.length === 0) { container.appendChild(createEl("span", "muted-text", "No relationships for drama")); return; }
    var sorted = rels.slice().sort(function(a, b) { return Math.abs(b.score) - Math.abs(a.score); });
    var shown = sorted.slice(0, 10);
    shown.forEach(function(rel) {
      var nameA = findCitizenName(rel.citizen_a), nameB = findCitizenName(rel.citizen_b);
      var entry = createEl("div", "feed-entry type-" + (rel.score >= 0 ? "speech" : "world"));
      entry.style.cssText = "padding:6px 10px;margin-bottom:4px;border-radius:4px;font-size:0.82rem";
      var text;
      if (rel.score > 0.5) text = nameA + " and " + nameB + "'s bond strengthened to " + rel.score.toFixed(2) + " (" + (rel.type || "neutral") + ")";
      else if (rel.score < -0.3) text = nameA + " and " + nameB + "'s rivalry deepened to " + rel.score.toFixed(2);
      else if (rel.score > 0) text = nameA + " and " + nameB + " maintain a tentative bond (" + rel.score.toFixed(2) + ")";
      else text = nameA + " and " + nameB + " have a strained connection (" + rel.score.toFixed(2) + ")";
      entry.appendChild(createEl("span", null, text));
      container.appendChild(entry);
    });
  }

  // --- 19. Prediction Engine (div#prediction-engine) ---
  function renderPredictionEngine() {
    var container = byId("prediction-engine"); if (!container) return; clearEl(container);
    var ls = state.live_state || {};
    var currentTick = ls.tick || 0;
    var currentVocab = state.shared_lexicon ? state.shared_lexicon.length : 0;
    var snaps = state.snapshots || [];
    var ustats = state.utterance_stats || {};
    var citizens = getCitizens();
    var allRels = state.relationships || [];

    function addPred(label, main, sub) {
      var item = createEl("div", "pred-item");
      item.appendChild(createEl("div", "pred-label", "\u25B8 " + label));
      item.appendChild(createEl("div", "pred-main", main));
      if (sub) item.appendChild(createEl("div", "pred-sub", sub));
      container.appendChild(item);
    }

    // 1. Vocab growth rate and next 5-word milestone
    var growthRate = 0;
    if (snaps.length >= 2) {
      var recentSnaps = snaps.slice(-10);
      var firstSnap = recentSnaps[0], lastSnap = recentSnaps[recentSnaps.length - 1];
      var vocabDiff = (lastSnap.shared_vocab_size || 0) - (firstSnap.shared_vocab_size || 0);
      var tickDiff = (lastSnap.tick || 0) - (firstSnap.tick || 0);
      if (tickDiff > 0) growthRate = vocabDiff / tickDiff;
    }
    var nextMilestone5 = currentVocab + 5;
    var ticksToMilestone = growthRate > 0 ? Math.round(5 / growthRate) : null;
    addPred(
      "VOCAB MILESTONE",
      ticksToMilestone != null ? "Next 5 words in ~" + ticksToMilestone + " ticks" : "Next milestone: " + nextMilestone5 + " words",
      "Current rate: " + (growthRate * 10).toFixed(1) + " words/10 ticks  \u00B7  now at " + currentVocab + " words"
    );

    // 2. Communication success trend from snapshots
    if (snaps.length >= 4) {
      var recentForTrend = snaps.slice(-20);
      var half = Math.floor(recentForTrend.length / 2);
      var earlySuccess = 0, lateSuccess = 0, earlyCount = 0, lateCount = 0;
      recentForTrend.forEach(function(s, idx) {
        var sr = s.communication_success_rate || 0;
        if (idx < half) { earlySuccess += sr; earlyCount++; }
        else { lateSuccess += sr; lateCount++; }
      });
      var earlyAvg = earlyCount > 0 ? earlySuccess / earlyCount : 0;
      var lateAvg = lateCount > 0 ? lateSuccess / lateCount : 0;
      var delta = lateAvg - earlyAvg;
      var trendLabel = Math.abs(delta) < 0.02 ? "stable" : delta > 0 ? "improving" : "declining";
      var trendDetail = delta !== 0 ? (delta > 0 ? "+" : "") + Math.round(delta * 100) + "% over last " + recentForTrend.length + " snapshots" : "no significant change";
      addPred("COMMUNICATION TREND", "Success rate " + trendLabel, trendDetail);
    } else {
      var successRate = ustats.total_utterances > 0 ? Math.round((ustats.successful / ustats.total_utterances) * 100) : 0;
      addPred("COMMUNICATION TREND", "Current success rate: " + successRate + "%", "Accumulating history for trend analysis");
    }

    // 3. Most isolated citizen
    if (citizens.length > 0) {
      var lexByCit = state.lexicon_by_citizen || {};
      var sharedSounds = {};
      (state.shared_lexicon || []).forEach(function(w) { sharedSounds[w.sound] = true; });
      var mostIsolated = null, minShared = Infinity;
      citizens.forEach(function(c) {
        var personalVocab = lexByCit[c.id] || [];
        var sharedCount = personalVocab.filter(function(v) { return sharedSounds[v.sound]; }).length;
        var relCount = allRels.filter(function(r) { return r.citizen_a === c.id || r.citizen_b === c.id; }).length;
        if (sharedCount < minShared) { minShared = sharedCount; mostIsolated = { citizen: c, sharedCount: sharedCount, relCount: relCount }; }
      });
      if (mostIsolated) {
        addPred(
          "ISOLATION RISK",
          mostIsolated.citizen.name + " shares " + mostIsolated.sharedCount + " word" + (mostIsolated.sharedCount !== 1 ? "s" : "") + " with " + mostIsolated.relCount + " nearby citizen" + (mostIsolated.relCount !== 1 ? "s" : ""),
          mostIsolated.sharedCount === 0 ? "Language isolation detected — no shared vocabulary" : "Low shared vocabulary may limit bonding"
        );
      }
    }

    // 4. Next expected event
    var lexiconGrowthRecent = snaps.length >= 2 && growthRate > 0;
    if (lexiconGrowthRecent) {
      var ticksTo10 = currentVocab < 10 && growthRate > 0 ? Math.round((10 - currentVocab) / growthRate) : null;
      if (ticksTo10 != null && ticksTo10 > 0) {
        addPred("NEXT EVENT", "First-words milestone in ~" + ticksTo10 + " ticks", "Tribe approaching 10 shared words threshold");
      }
    }

    if (container.children.length === 0) {
      container.appendChild(createEl("span", "muted-text", "Accumulating data for predictions..."));
    }
  }

  // --- 20. Environmental Storytelling (div#env-storytelling) ---
  function renderEnvStorytelling() {
    var container = byId("env-storytelling"); if (!container) return; clearEl(container);
    var narratives = state.narratives || [];
    var events = state.world_events || [];
    if (narratives.length === 0 && events.length === 0) { container.appendChild(createEl("span", "muted-text", "No narratives or events yet")); return; }
    // Prefer narratives, fall back to world events
    var entries = narratives.length > 0 ? narratives.slice(-10).reverse() : events.slice(-10).reverse();
    entries.forEach(function(e) {
      var card = createEl("div", "feed-entry type-world");
      card.style.cssText = "padding:8px 12px;margin-bottom:6px;border-radius:4px;border-left:3px solid #d4a574";
      var tick = createEl("span", "feed-tick", "T" + (e.tick || "?"));
      card.appendChild(tick);
      card.appendChild(document.createTextNode(" "));
      var text = e.text || e.description || "";
      var textEl = createEl("span"); textEl.style.cssText = "font-style:italic;color:var(--text-secondary)";
      textEl.textContent = text;
      card.appendChild(textEl);
      container.appendChild(card);
    });
  }

  // --- 21. Consciousness Scores (canvas#chart-consciousness) ---
  function drawConsciousnessScores() {
    var r = setupCanvas("chart-consciousness"); if (!r) return;
    var ctx = r.ctx, w = r.w, h = r.h;
    var citizens = getCitizens(), lex = state.lexicon_by_citizen || {}, rels = state.relationships || [];
    var utterances = state.recent_utterances || [];
    if (citizens.length === 0) { drawNoData(ctx, w, h, "No citizens for consciousness scoring"); return; }
    var data = [];
    citizens.forEach(function(c) {
      var vocabSize = (lex[c.id] || []).length;
      var relCount = rels.filter(function(r2) { return r2.citizen_a === c.id || r2.citizen_b === c.id; }).length;
      var age = c.age || 0;
      var total = 0, success = 0;
      utterances.forEach(function(u) { if (u.citizen_id === c.id) { total++; if (u.success) success++; } });
      var successRate = total > 0 ? success / total : 0;
      var score = vocabSize * 0.3 + relCount * 0.2 + age * 0.2 + successRate * 0.3;
      data.push({ name: c.name, id: c.id, score: score });
    });
    data.sort(function(a, b) { return b.score - a.score; });
    var maxScore = data[0].score || 1;
    var pad = { top: 10, bottom: 10, left: 70, right: 40 }, barArea = w - pad.left - pad.right;
    var bH = Math.max(12, Math.min(20, (h - pad.top - pad.bottom) / data.length - 2));
    data.forEach(function(d, i) {
      var y = pad.top + i * (bH + 2);
      var bw = (d.score / maxScore) * barArea;
      ctx.fillStyle = "rgba(90,84,101,0.7)"; ctx.font = "9px 'Inter', sans-serif"; ctx.textAlign = "right";
      ctx.fillText(d.name.substring(0, 8), pad.left - 4, y + bH - 3);
      ctx.fillStyle = PALETTE[i % PALETTE.length]; roundedRect(ctx, pad.left, y, bw, bH, 3); ctx.fill();
      ctx.fillStyle = "#f0e0cc"; ctx.font = "8px 'JetBrains Mono', monospace"; ctx.textAlign = "left";
      ctx.fillText(d.score.toFixed(1), pad.left + bw + 4, y + bH - 3);
    });
  }

  // --- 22. Proto-Grammar Log (div#proto-grammar-log) ---
  function renderProtoGrammarLog() {
    var container = byId("proto-grammar-log"); if (!container) return; clearEl(container);
    var utterances = state.recent_utterances || [];
    if (utterances.length === 0) { container.appendChild(createEl("span", "muted-text", "No utterances for grammar detection")); return; }
    // Find 2-word patterns used more than once
    var pairCounts = {};
    utterances.forEach(function(u) {
      var words = (u.utterance || "").split(/\s+/).filter(function(w) { return w.length > 0; });
      for (var i = 0; i < words.length - 1; i++) {
        var pair = words[i] + " " + words[i + 1];
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
      }
    });
    var patterns = [];
    for (var pair in pairCounts) {
      if (pairCounts[pair] >= 2) patterns.push({ pair: pair, count: pairCounts[pair] });
    }
    patterns.sort(function(a, b) { return b.count - a.count; });
    if (patterns.length === 0) { container.appendChild(createEl("span", "muted-text", "No repeated 2-word patterns detected yet")); return; }
    patterns.slice(0, 15).forEach(function(p) {
      var entry = createEl("div", "etymology-card");
      entry.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-bottom:4px";
      var soundSpan = createEl("span", "cascade-sound", p.pair);
      entry.appendChild(soundSpan);
      var countBadge = createEl("span", "milestone-badge", p.count + "x");
      countBadge.style.cssText = "font-size:0.75rem;padding:2px 8px";
      entry.appendChild(countBadge);
      container.appendChild(entry);
    });
  }

  // --- 23. Timelapse Controls (div#timelapse-controls) ---
  var timelapseInterval = null;
  var timelapseIdx = 0;
  function initTimelapse() {
    var container = byId("timelapse-controls"); if (!container) return; clearEl(container);
    var snaps = state.snapshots || [];
    if (snaps.length < 2) { container.appendChild(createEl("span", "muted-text", "Need snapshots for timelapse")); return; }
    var controls = createEl("div"); controls.style.cssText = "display:flex;align-items:center;gap:8px";
    var playBtn = createEl("button", "citizen-action-btn", "Play");
    var pauseBtn = createEl("button", "citizen-action-btn", "Pause");
    var info = createEl("span", "muted-text", "Snapshot 1/" + snaps.length);
    playBtn.addEventListener("click", function() {
      if (timelapseInterval) return;
      timelapseInterval = setInterval(function() {
        if (!state || !state.snapshots || state.snapshots.length < 2) return;
        var snps = state.snapshots;
        timelapseIdx = (timelapseIdx + 1) % snps.length;
        var snap = snps[timelapseIdx];
        info.textContent = "T" + snap.tick + " | Day " + (snap.day || "?") + " | " + (snap.season || "?") + " (" + (timelapseIdx + 1) + "/" + snps.length + ")";
        setText("scrubber-tick", "T" + snap.tick + " | Day " + snap.day);
      }, 500);
    });
    pauseBtn.addEventListener("click", function() {
      if (timelapseInterval) { clearInterval(timelapseInterval); timelapseInterval = null; }
    });
    controls.appendChild(playBtn);
    controls.appendChild(pauseBtn);
    controls.appendChild(info);
    container.appendChild(controls);
  }

  // --- Wire new features into existing hooks ---
  var extraLearningCharts = [
    ["semanticFields", drawSemanticFieldChart],
    ["phonemeFreq", drawPhonemeFreqChart],
    ["archetypeCompare", drawArchetypeCompare],
    ["relTypes", drawRelTypesChart],
    ["survivalCurves", drawSurvivalCurves],
    ["eventFreq", drawEventFreqChart],
    ["moodHeatmap", drawMoodHeatmap],
    ["vocabOverlap", drawVocabOverlap],
    ["transferNetwork", drawTransferNetwork],
    ["worldLeaderboard", renderWorldLeaderboard],
    ["predationTimeline", drawPredationTimeline],
    ["worldOverlay", drawWorldOverlay],
    ["etymology", renderEtymology],
    ["familyTree", drawFamilyTree],
    ["dialectRegions", drawDialectRegions],
    ["languageDeath", drawLanguageDeath],
    ["migrationPatterns", drawMigrationPatterns],
    ["seasonalLanguage", drawSeasonalLanguage],
    ["nightDaySounds", drawNightDaySounds],
    ["influenceDecay", drawInfluenceDecay],
    ["wordWars", drawWordWars],
    ["phonemeEvolution", drawPhonemeEvolution],
    ["adoptionSpeed", drawAdoptionSpeed],
    ["archetypeRivalry", drawArchetypeRivalry],
    ["foodChain", drawFoodChain],
    ["languageTree", drawLanguageTree],
    ["relStrength", drawRelStrengthOverTime],
    ["eventCausality", drawEventCausality],
    ["dangerHeatmap", drawDangerHeatmap],
    ["citizenSpotlight", renderCitizenSpotlight],
    ["dramaFeed", renderDramaFeed],
    ["predictionEngine", renderPredictionEngine],
    ["envStorytelling", renderEnvStorytelling],
    ["consciousness", drawConsciousnessScores],
    ["protoGrammar", renderProtoGrammarLog],
    ["timelapse", initTimelapse],
  ];

  // Override renderLearningTab to include new charts
  var origCharts = renderLearningTab;
  renderLearningTab = function() {
    origCharts();
    extraLearningCharts.forEach(function(c) { safe("learning/" + c[0], c[1]); });
    safe("learning/deltas", updateScienceDeltas);
  };

  // --- World Transition Detection ---
  var lastSeenTick = -1;
  var tickStaleCount = 0;
  var worldTransitionShown = false;

  function checkWorldTransition() {
    if (!state || !state.live_state) return;
    var currentTick = state.live_state.tick || 0;

    if (currentTick === lastSeenTick) {
      tickStaleCount++;
    } else {
      tickStaleCount = 0;
      lastSeenTick = currentTick;
      // World came back — hide transition banner
      if (worldTransitionShown) {
        var banner = byId("world-transition");
        if (banner) banner.style.display = "none";
        worldTransitionShown = false;
        log(LOG_LEVEL.INFO, "world", "World is live again at tick " + currentTick);
      }
    }

    // If tick hasn't changed for ~2 minutes (24 polls at 5s), show transition banner
    if (tickStaleCount >= 24 && !worldTransitionShown) {
      var banner = byId("world-transition");
      if (banner) {
        banner.style.display = "flex";
        worldTransitionShown = true;
        // Update status with world info
        var worlds = state.worlds || [];
        var statusEl = byId("wt-status");
        if (statusEl && worlds.length > 0) {
          var lastWorld = worlds[0];
          setText("wt-status", "World " + lastWorld.world_id + " completed with " +
            (lastWorld.interactions || 0) + " interactions and " +
            (lastWorld.shared_words || 0) + " shared words. Training in progress...");
        }
        log(LOG_LEVEL.INFO, "world", "World transition detected — tick stale for " + (tickStaleCount * 5) + "s");
      }
    }
  }

  // Wire into update cycle
  var _origUpdate = update;
  update = function() {
    _origUpdate();
    safe("feat/latency", updateConnectionLatency);
    safe("feat/perfOverlay", updatePerfOverlay);
    safe("feat/worldTransition", checkWorldTransition);
    // Throttle localStorage writes to once per minute
    if (pollCount % 12 === 0) safe("feat/historySave", saveHistoryToStorage);
    // Show scrubber if snapshots exist, add padding so content isn't hidden behind it
    if (state && state.snapshots && state.snapshots.length > 2) {
      var bar = byId("scrubber-bar");
      if (bar) {
        bar.style.display = "flex";
        var main = document.querySelector(".tab-content");
        if (main) main.style.paddingBottom = "50px";
      }
    }
  };

  // Wire init hooks
  var _origInit = init;
  init = function() {
    loadHistoryFromStorage();
    _origInit();
    safe("feat/search", initCitizenSearch);
    safe("feat/scrubber", initScrubber);
    safe("feat/swipe", initMobileSwipe);
    // Inspect panel close button
    var closeBtn = byId("inspect-close"); if (closeBtn) closeBtn.addEventListener("click", closeInspectPanel);
    var compareClose = byId("compare-close"); if (compareClose) compareClose.addEventListener("click", function() { compareIds = []; var p = byId("compare-panel"); if (p) p.style.display = "none"; });
    // Export CSV button
    var exportBtn = byId("export-learning-csv"); if (exportBtn) exportBtn.addEventListener("click", exportLearningCSV);
    // Perf overlay toggle (Ctrl+Shift+P)
    document.addEventListener("keydown", function(e) {
      if (e.ctrlKey && e.shiftKey && e.key === "P") { var el = byId("perf-overlay"); if (el) el.style.display = el.style.display === "none" ? "flex" : "none"; e.preventDefault(); }
    });
    // Map click for citizen inspect — compare in screen space (more reliable)
    var mapCanvas = byId("map-canvas");
    if (mapCanvas) {
      mapCanvas.addEventListener("click", function(e) {
        var citizens = getCitizens(); if (citizens.length === 0) return;
        var rect = mapCanvas.getBoundingClientRect();
        var clickX = e.clientX - rect.left, clickY = e.clientY - rect.top;

        // Convert each citizen's world position to screen position and find nearest
        var cssW = rect.width, cssH = rect.height;
        var scaleX = cssW / ENV_COLS, scaleY = cssH / ENV_ROWS;
        var baseScale = Math.max(scaleX, scaleY);
        var scale = baseScale * mapZoom;

        var best = null, bestDist = 40; // 40 CSS pixels click radius
        citizens.forEach(function(c) {
          var pos = citizenPositions[c.id]; if (!pos) return;
          // World → screen (same transform as drawMap)
          var sx = (pos.x / TILE_PX) * scale + mapPanX;
          var sy = (pos.y / TILE_PX) * scale + mapPanY;
          var dx = sx - clickX, dy = sy - clickY;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) { bestDist = dist; best = c; }
        });
        if (best) {
          openInspectPanel(best.id);
        }
      });
    }
    log(LOG_LEVEL.INFO, "features", "40 features initialized");
  };

  // ---------------------------------------------------------------------------
  // PROTO-SOUNDS TAB
  // ---------------------------------------------------------------------------

  var _psFilter = "ALL";
  var _psSort = "newest";
  var _psCurrentlyPlaying = null; // { sound, btn, card }

  var MEANING_COLORS = {
    GREETING: { hex: "#4a9e6e", rgb: "74,158,110" },
    DANGER:   { hex: "#c44a20", rgb: "196,74,32" },
    FOOD:     { hex: "#d4a574", rgb: "212,165,116" },
    PAIN:     { hex: "#cc7a40", rgb: "204,122,64" },
    SELF:     { hex: "#5a9bba", rgb: "90,155,186" },
    WATER:    { hex: "#5a9bba", rgb: "90,155,186" },
    MATE:     { hex: "#bf6abf", rgb: "191,106,191" },
    SHELTER:  { hex: "#8a6abf", rgb: "138,106,191" },
  };
  function meaningColor(m) {
    return MEANING_COLORS[m] || { hex: "#d4a574", rgb: "212,165,116" };
  }

  function renderProtoSoundsTab() {
    if (!state) return;

    var clips = state.voice_clips || [];
    var lexicon = state.shared_lexicon || [];
    var worlds = state.worlds || [];

    // ---- hero stats ----
    var uniqueSounds = {};
    clips.forEach(function(c) { uniqueSounds[c.sound] = true; });
    var numSounds = Object.keys(uniqueSounds).length;
    var numClips = clips.filter(function(c) { return c.has_audio; }).length;
    var numWorlds = worlds.length;
    setText("ps-n-sounds", numSounds || lexicon.length);
    setText("ps-n-clips", numClips);
    setText("ps-n-worlds", numWorlds);

    // ---- build combined sound list from voice_clips + shared_lexicon ----
    // Merge: voice_clips have audio flag; shared_lexicon has citizen_count
    var soundMap = {};
    clips.forEach(function(c) {
      if (!soundMap[c.sound]) {
        soundMap[c.sound] = {
          sound: c.sound,
          meaning: (c.meaning || "?").toUpperCase(),
          citizen_id: c.citizen_id,
          tick: c.tick,
          has_audio: !!c.has_audio,
          citizen_count: 1,
        };
      } else if (c.has_audio) {
        soundMap[c.sound].has_audio = true;
      }
    });
    lexicon.forEach(function(l) {
      var s = l.sound;
      if (soundMap[s]) {
        soundMap[s].citizen_count = l.citizen_count || soundMap[s].citizen_count;
      } else {
        soundMap[s] = {
          sound: s,
          meaning: (l.meaning || "?").toUpperCase(),
          citizen_id: null,
          tick: l.tick_established || 0,
          has_audio: false,
          citizen_count: l.citizen_count || 1,
        };
      }
    });

    var sounds = Object.values(soundMap);

    // ---- filter ----
    var filtered = sounds.filter(function(s) {
      return _psFilter === "ALL" || s.meaning === _psFilter;
    });

    // ---- sort ----
    var maxCitizens = filtered.reduce(function(mx, s) { return Math.max(mx, s.citizen_count || 0); }, 1);
    if (_psSort === "spread") {
      filtered.sort(function(a, b) { return (b.citizen_count || 0) - (a.citizen_count || 0); });
    } else {
      filtered.sort(function(a, b) { return (b.tick || 0) - (a.tick || 0); });
    }

    // ---- render grid ----
    var grid = byId("ps-grid");
    if (!grid) return;
    grid.textContent = "";

    if (filtered.length === 0) {
      var empty = createEl("div", "ps-empty");
      var pulse = createEl("div", "ps-empty-pulse", "◉");
      var msg = createEl("p", "", _psFilter === "ALL"
        ? "Waiting for the first sounds of a new world..."
        : "No " + _psFilter.toLowerCase() + " sounds yet.");
      empty.appendChild(pulse);
      empty.appendChild(msg);
      grid.appendChild(empty);
    } else {
      filtered.forEach(function(s) {
        grid.appendChild(buildSoundCard(s, maxCitizens));
      });
    }

    // ---- render world history ----
    renderProtoWorldHistory(worlds, soundMap);

    // ---- init filter buttons ----
    var filterBtns = document.querySelectorAll("#ps-filters .ps-f");
    filterBtns.forEach(function(btn) {
      btn.onclick = function() {
        filterBtns.forEach(function(b) { b.classList.remove("active"); });
        btn.classList.add("active");
        _psFilter = btn.dataset.f;
        renderProtoSoundsTab();
      };
    });
    var sortSel = byId("ps-sort");
    if (sortSel && !sortSel._psbound) {
      sortSel._psbound = true;
      sortSel.onchange = function() {
        _psSort = sortSel.value;
        renderProtoSoundsTab();
      };
    }
  }

  function buildSoundCard(s, maxCitizens) {
    var mc = meaningColor(s.meaning);
    var card = createEl("div", "sc");
    card.style.setProperty("--sc-color", mc.hex);
    card.style.setProperty("--sc-badge-rgb", mc.rgb);
    card.dataset.sound = s.sound;
    card.dataset.meaning = s.meaning;

    // badge
    var badge = createEl("div", "sc-badge", s.meaning);
    card.appendChild(badge);

    // word
    var word = createEl("div", "sc-word", s.sound);
    card.appendChild(word);

    // audio row
    var audioRow = createEl("div", "sc-audio-row");
    var playBtn = createEl("button", "sc-play-btn" + (s.has_audio ? "" : " no-audio"));
    playBtn.title = s.has_audio ? "Play " + s.sound : "No audio yet";
    playBtn.innerHTML = s.has_audio ? "&#9654;" : "&#9675;";
    if (s.has_audio) {
      playBtn.onclick = function() {
        if (_psCurrentlyPlaying && _psCurrentlyPlaying.sound === s.sound) {
          // stop
          stopProtoAudio();
        } else {
          stopProtoAudio();
          _psCurrentlyPlaying = { sound: s.sound, btn: playBtn, card: card };
          card.classList.add("playing");
          playBtn.classList.add("playing");
          playBtn.innerHTML = "&#9646;&#9646;";
          psPlayAudio(s.sound, function() {
            // on end
            if (_psCurrentlyPlaying && _psCurrentlyPlaying.sound === s.sound) {
              stopProtoAudio();
            }
          });
        }
      };
    }
    audioRow.appendChild(playBtn);

    // waveform bars
    var wave = createEl("div", "sc-wave");
    for (var i = 0; i < 5; i++) wave.appendChild(createEl("span", ""));
    audioRow.appendChild(wave);

    card.appendChild(audioRow);

    // meta
    var meta = createEl("div", "sc-meta");
    var citizen = createEl("span", "sc-meta-citizen", s.citizen_id ? s.citizen_id.replace("citizen_", "C") : "unknown");
    var tick = createEl("span", "", "tick " + (s.tick || "?"));
    meta.appendChild(citizen);
    meta.appendChild(tick);
    card.appendChild(meta);

    // spread bar
    if (maxCitizens > 1 || s.citizen_count > 1) {
      var spreadWrap = createEl("div", "sc-spread-wrap");
      var barBg = createEl("div", "sc-spread-bar");
      var fill = createEl("div", "sc-spread-fill");
      fill.style.width = Math.round(((s.citizen_count || 1) / Math.max(maxCitizens, 2)) * 100) + "%";
      barBg.appendChild(fill);
      spreadWrap.appendChild(barBg);
      var spreadTxt = createEl("div", "sc-spread-text", (s.citizen_count || 1) + " citizen" + (s.citizen_count !== 1 ? "s" : ""));
      spreadWrap.appendChild(spreadTxt);
      card.appendChild(spreadWrap);
    }

    return card;
  }

  function stopProtoAudio() {
    if (_psCurrentlyPlaying) {
      var old = _psCurrentlyPlaying;
      _psCurrentlyPlaying = null;
      if (old.btn) {
        old.btn.classList.remove("playing");
        old.btn.innerHTML = "&#9654;";
      }
      if (old.card) old.card.classList.remove("playing");
    }
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; }
    if (activePlayBtn) { activePlayBtn.classList.remove("playing"); activePlayBtn = null; }
  }

  function psPlayAudio(sound, onEnd) {
    if (audioPlayer) { audioPlayer.pause(); audioPlayer = null; }
    var url = "/api/audio?sound=" + encodeURIComponent(sound);
    if (API_KEY) url += "&key=" + encodeURIComponent(API_KEY);
    audioPlayer = new Audio(url);
    audioPlayer.addEventListener("ended", function() {
      audioPlayer = null;
      if (onEnd) onEnd();
    });
    audioPlayer.addEventListener("error", function() {
      audioPlayer = null;
      if (onEnd) onEnd();
    });
    audioPlayer.play().catch(function() {
      audioPlayer = null;
      if (onEnd) onEnd();
    });
  }

  function renderProtoWorldHistory(worlds, soundMap) {
    var list = byId("ps-worlds-list");
    if (!list) return;
    list.textContent = "";

    if (!worlds || worlds.length === 0) {
      list.appendChild(createEl("div", "ps-world-empty", "No world history yet."));
      return;
    }

    // For each world, show the sounds from voice_clips at that world's tick range
    // We can't perfectly attribute sounds to worlds without world_id on voice_clips,
    // so we show the shared lexicon for the current world and world metadata for past ones
    worlds.forEach(function(w) {
      var row = createEl("div", "ps-world-row" + (w.status === "active" ? " active-world" : ""));

      // header
      var header = createEl("div", "ps-world-header");
      var name = createEl("span", "ps-world-name", "World " + w.world_id);
      var status = createEl("span", "ps-world-status " + (w.status === "active" ? "active" : "ended"),
        w.status === "active" ? "LIVE" : "ENDED");
      header.appendChild(name);
      header.appendChild(status);

      var stats = createEl("div", "ps-world-stats");
      if (w.total_ticks) {
        var tickStat = createEl("span", "");
        var tickVal = createEl("span", "ps-world-stat-val");
        tickVal.textContent = w.total_ticks;
        tickStat.appendChild(tickVal);
        tickStat.appendChild(document.createTextNode(" ticks"));
        stats.appendChild(tickStat);
      }
      if (w.total_interactions) {
        var intStat = createEl("span", "");
        var intVal = createEl("span", "ps-world-stat-val");
        intVal.textContent = w.total_interactions;
        intStat.appendChild(intVal);
        intStat.appendChild(document.createTextNode(" interactions"));
        stats.appendChild(intStat);
      }
      if (w.shared_words) {
        var wordStat = createEl("span", "");
        var wordVal = createEl("span", "ps-world-stat-val");
        wordVal.textContent = w.shared_words;
        wordStat.appendChild(wordVal);
        wordStat.appendChild(document.createTextNode(" shared words"));
        stats.appendChild(wordStat);
      }
      header.appendChild(stats);
      row.appendChild(header);

      // sounds chips — for active world show current soundMap, for others show milestones if available
      var soundsRow = createEl("div", "ps-world-sounds");
      if (w.status === "active") {
        var soundList = Object.values(soundMap).slice(0, 24);
        if (soundList.length === 0) {
          soundsRow.appendChild(createEl("span", "ps-world-empty", "No sounds yet..."));
        } else {
          soundList.forEach(function(s) {
            var chip = createEl("button", "ps-sound-chip" + (s.has_audio ? " has-audio" : ""), s.sound);
            if (s.has_audio) {
              (function(sound) {
                chip.onclick = function() {
                  stopProtoAudio();
                  psPlayAudio(sound, null);
                };
              })(s.sound);
            }
            soundsRow.appendChild(chip);
          });
        }
      } else {
        // Parse milestones if available
        var milestones = [];
        try {
          milestones = typeof w.milestones_achieved === "string"
            ? JSON.parse(w.milestones_achieved)
            : (w.milestones_achieved || []);
        } catch(_) {}
        if (milestones.length > 0) {
          milestones.slice(0, 8).forEach(function(m) {
            var chip = createEl("span", "ps-sound-chip", "✓ " + m);
            chip.style.cursor = "default";
            soundsRow.appendChild(chip);
          });
        } else if (w.shared_words > 0) {
          soundsRow.appendChild(createEl("span", "ps-world-empty", w.shared_words + " words invented · audio not archived"));
        } else {
          soundsRow.appendChild(createEl("span", "ps-world-empty", "No language data archived"));
        }
      }
      row.appendChild(soundsRow);
      list.appendChild(row);
    });
  }

  // Expose functions globally for onclick handlers
  window.openInspectPanel = openInspectPanel;
  window.addToCompare = addToCompare;
  window.exportTableToCSV = exportTableToCSV;

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
