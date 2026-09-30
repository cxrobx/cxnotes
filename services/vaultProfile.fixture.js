'use strict';

/**
 * An invented vault profile and rule set for the tests: a consultant named
 * Chris with four clients (ACM, QRS, IBX, NXT), two ventures and a music
 * area. Nothing here is read by the app — a real profile lives in the
 * settings store (see vaultProfile.js).
 */

const FIXTURE_PROFILE = Object.freeze({
  "selfNames": [
    "chris",
    "chris robinson",
    "christopher",
    "christopher robinson",
    "robinson",
    "cxuser",
    "chrisx",
    "chris x"
  ],
  "filingStopwords": [
    "chris"
  ],
  "categoryByDestination": [
    {
      "folder": "Projects/CXVentures/Clients/ACM/Meetings",
      "code": "ACM"
    },
    {
      "folder": "Projects/CXVentures/Clients/QRS/Meetings",
      "code": "QRS"
    },
    {
      "folder": "Projects/CXVentures/Clients/IBX/Meetings",
      "code": "IBX"
    },
    {
      "folder": "Projects/CXVentures/Clients/NXT/Meetings",
      "code": "NXT"
    },
    {
      "folder": "Projects/CXVentures/Ventures/Artist Advisory/Calls",
      "code": "AA"
    },
    {
      "folder": "Projects/CXVentures/Ventures/BuildersBuddy/Calls",
      "code": "BB"
    },
    {
      "folder": "Areas/Music/Production Calls",
      "code": "MUS"
    },
    {
      "folder": "Areas/Music/Sync",
      "code": "SYNC"
    },
    {
      "folder": "Areas/Music",
      "code": "MUS"
    },
    {
      "folder": "Areas/Personal",
      "code": "PER"
    },
    {
      "folder": "Areas/Finances",
      "code": "FIN"
    },
    {
      "folder": "Archive/APEX9",
      "code": "APEX9"
    }
  ],
  "categoryByContent": [
    {
      "code": "OIQ",
      "keywords": [
        "orchid iq",
        "orchidiq",
        "oiq"
      ]
    },
    {
      "code": "TH",
      "keywords": [
        "teacherhero",
        "teacher hero",
        "teacher helper"
      ]
    },
    {
      "code": "ACM",
      "keywords": [
        "acm",
        "acme consulting"
      ]
    },
    {
      "code": "BD",
      "keywords": [
        "business development",
        "biz dev",
        "bizdev"
      ]
    },
    {
      "code": "CXV",
      "keywords": [
        "cxv",
        "cx ventures",
        "cxventures"
      ]
    }
  ],
  "discoveryGroups": [
    {
      "parent": "Projects/CXVentures/Clients",
      "subdirs": [
        "Meetings",
        "Calls"
      ]
    },
    {
      "parent": "Projects/CXVentures/Ventures",
      "subdirs": [
        "Calls",
        "Meetings"
      ]
    }
  ]
});

const FIXTURE_FILING_RULES = Object.freeze([
  {
    "id": "qrs",
    "destination": "Projects/CXVentures/Clients/QRS/Meetings",
    "keywords": [
      "qrs",
      "quantum robotics",
      "lsa"
    ],
    "people": []
  },
  {
    "id": "acm",
    "destination": "Projects/CXVentures/Clients/ACM/Meetings",
    "keywords": [
      "acm",
      "acme consulting",
      "partner network"
    ],
    "people": [
      "dominic"
    ]
  },
  {
    "id": "ibx",
    "destination": "Projects/CXVentures/Clients/IBX/Meetings",
    "keywords": [
      "ibx",
      "ibexco strategy",
      "ibx06"
    ],
    "people": []
  },
  {
    "id": "nxt",
    "destination": "Projects/CXVentures/Clients/NXT/Meetings",
    "keywords": [
      "nxt",
      "northbay",
      "synergy",
      "training academy"
    ],
    "people": [
      "tony"
    ]
  },
  {
    "id": "artist-advisory",
    "destination": "Projects/CXVentures/Ventures/Artist Advisory/Calls",
    "keywords": [
      "artist advisory",
      "artisttracker",
      "aa"
    ],
    "people": []
  },
  {
    "id": "buildersbuddy",
    "destination": "Projects/CXVentures/Ventures/BuildersBuddy/Calls",
    "keywords": [
      "buildersbuddy",
      "builders buddy",
      "bb"
    ],
    "people": []
  },
  {
    "id": "cxv-internal",
    "destination": "Meetings",
    "keywords": [
      "cx ventures",
      "cxventures",
      "cxv"
    ],
    "people": []
  },
  {
    "id": "music-production",
    "destination": "Areas/Music/Production Calls",
    "keywords": [
      "production call",
      "muzik",
      "mixdown",
      "mastering",
      "studio session"
    ],
    "people": []
  }
]);

module.exports = { FIXTURE_PROFILE, FIXTURE_FILING_RULES };
