# Cognit

## Reaction time collector

`ReactionTimeCollector` records the first movement, click, interaction, and
response timestamps for one attempt. Pass timestamps from the same monotonic
clock in milliseconds (for example, `performance.now()`). Missing event
timestamps are returned as `null`. Movement and click events also count as
interactions; only the first timestamp for each event is retained.

Call `finish(timestamp)` when the attempt ends. The result includes the
stimulus and first-event timestamps plus `totalTime`, calculated as the end
timestamp minus the stimulus timestamp. The total therefore remains available
when no response was recorded.

```js
import { ReactionTimeCollector } from "./src/reaction-time-collector.mjs";

const attempt = new ReactionTimeCollector(performance.now());
attempt.recordMovement(performance.now());
attempt.recordClick(performance.now());
const result = attempt.finish(performance.now());
```

Run the tests with `node --test`.
