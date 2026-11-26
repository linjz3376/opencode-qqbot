# Third-Party Notices

This file records upstream code, design references, and bundled dependencies whose licenses require attribution. It supplements, and does not replace, the project's [LICENSE](./LICENSE).

## Scope notes

- `src/core/reply-limiter.ts` is a derived revision of `tencent-connect/openclaw-qqbot/src/outbound/reply-limiter.ts`. The interface, defaults, and core state machine are intentionally preserved. It is not represented as independent original work.
- `src/core/outbound-sanitize.ts` is a derived revision of `openclaw-qqbot/src/outbound/sanitize.ts`, retaining the principal regular expressions and stripping sequence with project-specific consolidation.
- `normalizeLocalPath` in `src/core/send-media.ts` is a derived revision of `openclaw-qqbot/src/outbound/local-file-router.ts`'s `normalizePath`. The rest of the send-media workflow is implemented independently by this project.
- `src/qq/sender.ts`, `src/core/card-approval.ts`, `src/core/context-buffer.ts`, `src/core/delivery.ts`, `src/core/notices.ts`, and `src/bridge.ts` contain independent project implementations or extensions informed by the sources below. These references do not imply that every file is copied.
- `dist/openqq-bot.js` contains bundled code from `ws`. The `ws` copyright and license below must remain with distributed copies of that bundle.

## tencent-connect/openclaw-qqbot

- Source: https://github.com/tencent-connect/openclaw-qqbot
- Reviewed source revision: `89988812442583bf47c34b89f9abf5fd4b85df0b`
- Used for: the derived reply limiter, outbound sanitizer, local-path normalization, and related passive-reply design references.
- License: MIT

```text
MIT License

Copyright (c) 2026 sliverp
Copyright (c) 2026 Tencent Connect

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## tencent-connect/dsh-qqbot

- Source: https://github.com/tencent-connect/dsh-qqbot
- Reviewed baseline: `63abb82` (the clone also contains that baseline revision).
- Used for: chunking, button-data, approval-channel, and msgid-cache design references.
- License: MIT

```text
MIT License

Copyright (c) 2026 Tencent Connect

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @tencent-connect/qqbot-nodejs

- Source: https://github.com/tencent-connect/qqbot-nodejs
- npm package: `@tencent-connect/qqbot-nodejs@1.0.5`
- Used for: protocol shapes and quote-reference design references.
- License: MIT

```text
MIT License

Copyright (c) 2026 Tencent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ws

- Source: https://github.com/websockets/ws
- Reviewed npm package: `ws@8.22.0` (declared dependency range: `^8.18.0`).
- Used for: WebSocket implementation bundled into `dist/openqq-bot.js`.
- License: MIT

```text
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
