# More Models Grouping

## Change Summary

Text model responses now include a `moreModel` boolean. LobsterAI keeps normal models first and places entries with `moreModel=true` in a default-collapsed “More models” section at the bottom of the current model group.

## Endpoint Details

The additive field is returned by both model-list sources used by the desktop client:

- `GET /api/models/available`
- `GET /api/models/pricing-catalog` in each `textModels` entry

```json
{
  "modelId": "legacy-model",
  "modelName": "Legacy Model",
  "moreModel": true
}
```

Existing models and older Server versions are treated as `moreModel=false`.

## Frontend Action Items

- Preserve the order received from Server inside the normal and more-model sections.
- Always render the normal section first, regardless of the numeric sort value of a more model.
- Collapse the more-model section when the selector opens, except when the current model belongs to that section; in that case expand it so the current selection remains visible.

## Auth Requirements

`/api/models/available` keeps its existing authenticated access requirements. `/api/models/pricing-catalog` remains public.

## Notes & Caveats

This field controls presentation only. It does not change model availability, billing, provider routing, or the model identifier sent for requests.
