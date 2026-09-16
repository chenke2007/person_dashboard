const unavailableMetrics = {
  raw: null,
  wiki: null,
  topics: null,
  candidates: null,
  filmed: null,
  runs: null,
  knowledgeContribution: null,
};

export const fallbackOverview = {
  generatedAt: null,
  metrics: unavailableMetrics,
  wikiStatus: {
    active: null,
    needsReview: null,
    deprecated: null,
  },
  recent: [],
  activity: [],
  qualityNotices: ["本地数据服务不可用，未展示任何统计数据。"],
};

export const fallbackCollections = {
  materials: [],
  wiki: [],
  content: [],
  archive: [],
};

export const fallbackSearchResults = [];
