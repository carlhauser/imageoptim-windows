"use strict";
const path = require("path");
const webpack = require("webpack");

module.exports = {
    cache: true,
    context: __dirname,
    entry: "./index.js",
    output: {
        path: path.join(__dirname, "build"),
        filename: "svgo.js",
    },
    target: "node",
    mode: "production",
    optimization: {
        minimize: true,
    },
    // svgo 4's loadConfig() imports svgo.config.js by a computed path, which
    // webpack cannot follow. index.js passes its config directly and never
    // calls it.
    ignoreWarnings: [{ module: /svgo-node\.cjs$/, message: /Critical dependency/ }],
};
