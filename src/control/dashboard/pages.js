// The modules only one page needs, each loaded as a chunk of its own: the home page's preview and its two sides, and
// the Cluster page's cards and its node's graphs, which bring uPlot.
export const pageModules = {
  home: () => import("./home.js"),
  cluster: () => Promise.all([import("./node-cards.js"), import("./node-switch.js"), import("./node-graphs.js")]),
};
