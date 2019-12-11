"use strict";

const {
  bindActionCreators
} = require(`redux`);

const {
  store
} = require(`..`);

const {
  actions: internalActions
} = require(`./internal`);

const {
  actions: publicActions
} = require(`./public`);

const {
  actions: restrictedActions,
  availableActionsByAPI
} = require(`./restricted`);

exports.internalActions = internalActions;
exports.publicActions = publicActions;
exports.restrictedActions = restrictedActions;
exports.restrictedActionsAvailableInAPI = availableActionsByAPI;
const actions = Object.assign({}, internalActions, {}, publicActions, {}, restrictedActions);
exports.actions = actions; // Deprecated, remove in v3

exports.boundActionCreators = bindActionCreators(actions, store.dispatch);
//# sourceMappingURL=index.js.map