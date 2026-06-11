"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.info = info;
exports.error = error;
function info(message) {
    console.log(`[aris] ${message}`);
}
function error(message, data) {
    console.error(`[aris] ${message}`, data || "");
}
