'use strict';

const { patchDingtalk } = require('./dingtalk.cjs');
const { patchLark } = require('./lark.cjs');
const { patchPopo } = require('./popo.cjs');
const { patchWeixin } = require('./weixin.cjs');

function applyOpenClawPluginPatches(context) {
  patchWeixin(context);
  patchPopo(context);
  patchLark(context);
  patchDingtalk(context);
}

module.exports = {
  applyOpenClawPluginPatches,
};
