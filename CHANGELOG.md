# [1.26.0](https://github.com/ibrahimshadev/Voxly/compare/v1.25.0...v1.26.0) (2026-06-10)


### Features

* custom video player and dot-grid meetings header ([ec29880](https://github.com/ibrahimshadev/Voxly/commit/ec2988069118093ce3b734258f713cea27e0d742))
* **meetings:** custom video player with transcript-aware seek bar ([ad33c83](https://github.com/ibrahimshadev/Voxly/commit/ad33c83615067f1f82eca725983af84140fc0d82))

# [1.25.0](https://github.com/ibrahimshadev/Voxly/compare/v1.24.0...v1.25.0) (2026-06-10)


### Features

* collapsible meeting config and resizable meeting panels ([519e18b](https://github.com/ibrahimshadev/Voxly/commit/519e18b72123f42f63799dd01aad00e7712b216d))
* **ui:** collapsible meeting config and resizable meeting panels ([1509817](https://github.com/ibrahimshadev/Voxly/commit/15098177f909526bcbf2d043af80d916bda0e179))

# [1.24.0](https://github.com/ibrahimshadev/Voxly/compare/v1.23.0...v1.24.0) (2026-06-10)


### Features

* configurable meeting summary model (Groq/OpenAI/custom) ([a19bdc2](https://github.com/ibrahimshadev/Voxly/commit/a19bdc269c73fd18de2f204aa0ca8e6bc76730a7))
* editable meeting titles with AI auto-title on summary ([b9a9e0d](https://github.com/ibrahimshadev/Voxly/commit/b9a9e0d3c0a1a4392968a6849e8f1ca582c32b03))
* **meeting:** add rename command and auto-title from summary ([797fba7](https://github.com/ibrahimshadev/Voxly/commit/797fba72d3e4fd06014d3b013eb140cfc2a9a971))
* **meeting:** provider-aware summary request body ([4eea3d4](https://github.com/ibrahimshadev/Voxly/commit/4eea3d447309b0a10fcdfaa80d59ee4c25d80e99))
* **meeting:** resolve summary provider config with legacy fallback ([39ac9c0](https://github.com/ibrahimshadev/Voxly/commit/39ac9c0416f22a43234f75a27aefc98b135a59fb))
* **meeting:** route summaries through configured provider ([11f4ab2](https://github.com/ibrahimshadev/Voxly/commit/11f4ab2ed49685f0e675ec579a8b5cd96620349d))
* **settings:** add summary model provider settings ([40d7bb2](https://github.com/ibrahimshadev/Voxly/commit/40d7bb2ed198476ae20736fb40a4672e460df35c))
* **ui:** add AI summary provider configuration tab ([290567f](https://github.com/ibrahimshadev/Voxly/commit/290567f1fb680b2e02f63e814ad8b25ef77afad7))
* **ui:** add summary model settings types and curated model lists ([0451a72](https://github.com/ibrahimshadev/Voxly/commit/0451a7283d383e31f9bf53246b3fc930f9543ea7))
* **ui:** make meeting title editable below the video player ([468131f](https://github.com/ibrahimshadev/Voxly/commit/468131fcc9cbaae741fb73adb20a37c463e6ade1))
* **ui:** make summary panel copy provider-aware ([10c5b74](https://github.com/ibrahimshadev/Voxly/commit/10c5b74cdf2274061ec960c8da175d051f8c68e4))
* **ui:** split meeting config into capture/transcription/summary tabs ([04bc06d](https://github.com/ibrahimshadev/Voxly/commit/04bc06dcdf00a99a23db7008deddf58d7e79808e))

# [1.23.0](https://github.com/ibrahimshadev/Voxly/compare/v1.22.0...v1.23.0) (2026-06-10)


### Features

* **meeting:** add ffmpeg progress parser and emit throttle ([f518fb0](https://github.com/ibrahimshadev/Voxly/commit/f518fb07137bdb51434dfb0dbe93eeacaf1b51bc))
* **meeting:** add groq gpt-oss-120b summary generation module ([e3f36ae](https://github.com/ibrahimshadev/Voxly/commit/e3f36ae204686c8918c30a96e2de78538ffb1e0e))
* **meeting:** add MeetingSummary type to meeting detail ([64c7f56](https://github.com/ibrahimshadev/Voxly/commit/64c7f56f4199fa0ea14860bbe3414db875525662))
* **meeting:** add non-joining signal to loopback recorder ([31b2315](https://github.com/ibrahimshadev/Voxly/commit/31b2315075f5ad04dd81a58fbecf86ca96d7dafe))
* **meeting:** add processing status and progress field to meeting events ([6180ac0](https://github.com/ibrahimshadev/Voxly/commit/6180ac06536d2176c1df5288a7caa224506dc921))
* **meeting:** expose generate_meeting_summary command ([11df5ab](https://github.com/ibrahimshadev/Voxly/commit/11df5abdd7af608738d26c2b21fc86b8022ebcfb))
* **meeting:** finalize recordings in background with processing status ([d29a169](https://github.com/ibrahimshadev/Voxly/commit/d29a169abf1c59d662f0c4c81c8a8e4af69bc82c))
* **meeting:** persist meeting summaries in sqlite ([b9992e3](https://github.com/ibrahimshadev/Voxly/commit/b9992e3052432f58953abf4256271b192a0bca41))
* **meeting:** reconcile orphaned processing meetings over live id set ([e4015ed](https://github.com/ibrahimshadev/Voxly/commit/e4015eda528423a527e0aec570d59f089ccf81ff))
* **meeting:** skip faststart on intermediate capture so quit is fast ([920ece9](https://github.com/ibrahimshadev/Voxly/commit/920ece952867f7e01b4b6966ee3ecf116390abc0))
* **meeting:** split recorder stop into signal and progress-reporting finalize ([9f718be](https://github.com/ibrahimshadev/Voxly/commit/9f718bee76ffa5e9053a5604dfd2b1cfb9f98837))
* **ui:** add markdown rendering foundation for meeting summaries ([9ba95c3](https://github.com/ibrahimshadev/Voxly/commit/9ba95c359b562a7fe4a44907c0e7f24aab87eeda))
* **ui:** add size props to dictation sine wave ([43aeb32](https://github.com/ibrahimshadev/Voxly/commit/43aeb32aab9f52d91891558da5af270eb156cc17))
* **ui:** allow dictation during meetings with combined pill ([ff26c33](https://github.com/ibrahimshadev/Voxly/commit/ff26c33e385c1b713dbceac9b398d0149f60b14f))
* **ui:** generate and render AI meeting summaries ([d1e5bff](https://github.com/ibrahimshadev/Voxly/commit/d1e5bff6e432f7ab579e389be72189a7b52d0178))
* **ui:** handle processing meeting state in pill ([346d98e](https://github.com/ibrahimshadev/Voxly/commit/346d98e4391c550268dfb3baed3eb1558f4b0e8e))
* **ui:** show saving progress for finalizing meetings ([4ffb783](https://github.com/ibrahimshadev/Voxly/commit/4ffb7832e432febb5c912f0468627f72c0d36104))

# [1.22.0](https://github.com/ibrahimshadev/Voxly/compare/v1.21.0...v1.22.0) (2026-06-03)


### Features

* **history:** show today's audio duration ([671e2be](https://github.com/ibrahimshadev/Voxly/commit/671e2be3ed621863cc75790b71b16adbe66c55cf))

# [1.21.0](https://github.com/ibrahimshadev/Voxly/compare/v1.20.0...v1.21.0) (2026-06-03)


### Features

* **docs:** add meeting transcription section to landing page ([d5d8c90](https://github.com/ibrahimshadev/Voxly/commit/d5d8c9062f4f4734e014a0a40fd1b114d82571b8))
* **storage:** migrate history and meetings to sqlite ([3700248](https://github.com/ibrahimshadev/Voxly/commit/370024895210f07487d40bfa281fd5315ea91ef8))

# [1.20.0](https://github.com/ibrahimshadev/Voxly/compare/v1.19.1...v1.20.0) (2026-06-03)


### Features

* **meetings:** add cloud transcripts ([06b4676](https://github.com/ibrahimshadev/Voxly/commit/06b467674e25db5146dcae706ac3a2b5bfd9e8bd))

## [1.19.1](https://github.com/ibrahimshadev/Voxly/compare/v1.19.0...v1.19.1) (2026-05-27)


### Bug Fixes

* **paste:** trim leading space, append trailing ([95337db](https://github.com/ibrahimshadev/Voxly/commit/95337db901cb0a1253bef6c2431ce4de82ddbaae))

# [1.19.0](https://github.com/ibrahimshadev/Voxly/compare/v1.18.1...v1.19.0) (2026-05-27)


### Features

* **audio:** preprocess dictation audio with ffmpeg ([f3a9440](https://github.com/ibrahimshadev/Voxly/commit/f3a94406bce50ded896b80fe543af2a72392d0e4))

## [1.18.1](https://github.com/ibrahimshadev/Voxly/compare/v1.18.0...v1.18.1) (2026-05-22)


### Bug Fixes

* **meetings:** hide ffmpeg console window ([8589cbb](https://github.com/ibrahimshadev/Voxly/commit/8589cbb2f5664f3c444ca72d710b616c5cee7b2f))

# [1.18.0](https://github.com/ibrahimshadev/Voxly/compare/v1.17.8...v1.18.0) (2026-05-20)


### Features

* **meetings:** add meeting recording ([aab1b71](https://github.com/ibrahimshadev/Voxly/commit/aab1b71515f4456d70acf5c3939444ae6b39bbc3))

## [1.17.8](https://github.com/ibrahimshadev/Voxly/compare/v1.17.7...v1.17.8) (2026-02-13)


### Bug Fixes

* **linux:** add deb, appimage, rpm to bundle targets ([8ebaf58](https://github.com/ibrahimshadev/Voxly/commit/8ebaf58fc28b560c15a65a3b22f8c31feabbf2b7))

## [1.17.7](https://github.com/ibrahimshadev/Voxly/compare/v1.17.6...v1.17.7) (2026-02-13)


### Bug Fixes

* **ci:** unify build step, continue-on-error for Linux upload ([754e4d6](https://github.com/ibrahimshadev/Voxly/commit/754e4d6fb09b002c280ca9113f978704144a131d))

## [1.17.6](https://github.com/ibrahimshadev/Voxly/compare/v1.17.5...v1.17.6) (2026-02-13)


### Bug Fixes

* **ci:** fn item to fn pointer cast for add_method, debug Linux artifacts ([2c69db8](https://github.com/ibrahimshadev/Voxly/commit/2c69db8ada2ee565aaa92e5ae8856b405a90685c))

## [1.17.5](https://github.com/ibrahimshadev/Voxly/compare/v1.17.4...v1.17.5) (2026-02-13)


### Bug Fixes

* **ci:** safe extern C fn for objc2 0.6, tauri-action for Linux build ([85afab4](https://github.com/ibrahimshadev/Voxly/commit/85afab49d993b0085fd6e154f073af9e5c795a8f))

## [1.17.4](https://github.com/ibrahimshadev/Voxly/compare/v1.17.3...v1.17.4) (2026-02-13)


### Bug Fixes

* **macos:** upgrade enigo 0.2→0.6 to resolve dual objc2 version conflict ([676e700](https://github.com/ibrahimshadev/Voxly/commit/676e7001f96a637c7e13b0546a62bf5d5ae7d9d1))

## [1.17.3](https://github.com/ibrahimshadev/Voxly/compare/v1.17.2...v1.17.3) (2026-02-13)


### Bug Fixes

* **ci:** macOS HRTB lifetime on add_method, Linux artifact paths ([fb1f239](https://github.com/ibrahimshadev/Voxly/commit/fb1f239c0b06a11775cefad40e30986532bc461e))

## [1.17.2](https://github.com/ibrahimshadev/Voxly/compare/v1.17.1...v1.17.2) (2026-02-13)


### Bug Fixes

* **ci:** macOS CStr conversion, bypass tauri-action for Linux upload ([e2d0f7e](https://github.com/ibrahimshadev/Voxly/commit/e2d0f7ec42f88553551421e90d3bdbbafddb8369))

## [1.17.1](https://github.com/ibrahimshadev/Voxly/compare/v1.17.0...v1.17.1) (2026-02-13)


### Bug Fixes

* **ci:** resolve macOS and Linux build failures ([2131dd5](https://github.com/ibrahimshadev/Voxly/commit/2131dd590742337709da379b5c1a88037b60ff87))

# [1.17.0](https://github.com/ibrahimshadev/Voxly/compare/v1.16.4...v1.17.0) (2026-02-13)


### Features

* **linux:** add Linux (.deb, .AppImage) distribution support ([64a1331](https://github.com/ibrahimshadev/Voxly/commit/64a13312f23bbc1076eb9eb51f24ac0bb7aa122c))

## [1.16.4](https://github.com/ibrahimshadev/Voxly/compare/v1.16.3...v1.16.4) (2026-02-10)


### Bug Fixes

* **pill:** unify click-through as single-authority cursor tracker ([51ebade](https://github.com/ibrahimshadev/Voxly/commit/51ebadefab43b819553ec134c7b12d62583e0bb8))

## [1.16.3](https://github.com/ibrahimshadev/dikt/compare/v1.16.2...v1.16.3) (2026-02-09)


### Bug Fixes

* **pill:** simplify click-through with reactive hover tracking ([6d8cb1d](https://github.com/ibrahimshadev/dikt/commit/6d8cb1d2da54ee5dd87a15e389e6326cf11b743b))

## [1.16.2](https://github.com/ibrahimshadev/dikt/compare/v1.16.1...v1.16.2) (2026-02-08)


### Bug Fixes

* **settings:** improve modes UX and developer prompt ([a93cc5f](https://github.com/ibrahimshadev/dikt/commit/a93cc5fba922de9d5d29df553a1eb8568637d688))

## [1.16.1](https://github.com/ibrahimshadev/dikt/compare/v1.16.0...v1.16.1) (2026-02-08)


### Bug Fixes

* **icons:** redesign app icon for crisp taskbar rendering ([622d524](https://github.com/ibrahimshadev/dikt/commit/622d524a6c1e5a953a1cd57a119e3bb0e002b434))

# [1.16.0](https://github.com/ibrahimshadev/dikt/compare/v1.15.0...v1.16.0) (2026-02-08)


### Features

* **audio:** add live mic visualizer to settings panel ([1418f7f](https://github.com/ibrahimshadev/dikt/commit/1418f7f41a8c5cd3e56001a3bfa1e2759a6106cb))

# [1.15.0](https://github.com/ibrahimshadev/dikt/compare/v1.14.0...v1.15.0) (2026-02-07)


### Features

* **settings:** add modes page, per-provider keys, and duration fallback ([1232547](https://github.com/ibrahimshadev/dikt/commit/12325471969fb740f0b742bde1c19b0f7d3ea3f7))
* **settings:** redesign settings as multi-page dashboard with history ([a2e04bd](https://github.com/ibrahimshadev/dikt/commit/a2e04bd4eaa49c7cda3b11a06cf9991a615eb404))

# [1.14.0](https://github.com/ibrahimshadev/dikt/compare/v1.13.1...v1.14.0) (2026-02-06)


### Features

* **modes:** add post-transcription formatting modes ([037dbcb](https://github.com/ibrahimshadev/dikt/commit/037dbcb1af52167314aef3a3270dcb7965620064))

## [1.13.1](https://github.com/ibrahimshadev/dikt/compare/v1.13.0...v1.13.1) (2026-02-06)


### Bug Fixes

* **window:** ensure WS_EX_LAYERED persists and tighten hot zone ([1611b51](https://github.com/ibrahimshadev/dikt/commit/1611b5175208616f7fe930e7d557ef3075718c6b))

# [1.13.0](https://github.com/ibrahimshadev/dikt/compare/v1.12.0...v1.13.0) (2026-02-06)


### Bug Fixes

* **window:** prevent pill from becoming invisible over time ([43a1337](https://github.com/ibrahimshadev/dikt/commit/43a13370f82f2b45c414098313086b69d794fc8f))


### Features

* **history:** add transcription history with settings tab ([7b817c1](https://github.com/ibrahimshadev/dikt/commit/7b817c166b39f888ab22c645fe2b9a0a4e47371d))

# [1.12.0](https://github.com/ibrahimshadev/dikt/compare/v1.11.0...v1.12.0) (2026-02-05)


### Features

* **settings:** add output mode with clipboard copy option and fix settings layout ([12abcfa](https://github.com/ibrahimshadev/dikt/commit/12abcfa593679673d216fc3bd004081954153a8a))

# [1.11.0](https://github.com/ibrahimshadev/dikt/compare/v1.10.0...v1.11.0) (2026-02-05)


### Features

* **window:** two-window architecture with cursor passthrough ([5c6c2d5](https://github.com/ibrahimshadev/dikt/commit/5c6c2d55ebaf2e50fbb65dab5f36dcd47896aca4))

# [1.10.0](https://github.com/ibrahimshadev/dikt/compare/v1.9.0...v1.10.0) (2026-02-04)


### Features

* **ui:** replace WaveBars with SiriWave animation for recording state ([f1cbeee](https://github.com/ibrahimshadev/dikt/commit/f1cbeeed2b7e0dfcf52ffd180b9b2d51fbc6173e))

# [1.9.0](https://github.com/ibrahimshadev/dikt/compare/v1.8.0...v1.9.0) (2026-02-04)


### Features

* **tray:** add reset position menu item to recover off-screen window ([ac8ab30](https://github.com/ibrahimshadev/dikt/commit/ac8ab30b50d1ae5ff3eaba9a935883893b320c98))

# [1.8.0](https://github.com/ibrahimshadev/dikt/compare/v1.7.0...v1.8.0) (2026-02-04)


### Features

* **ui:** tighten idle pill ([2b54e6f](https://github.com/ibrahimshadev/dikt/commit/2b54e6fb187cf7c6100435c5fc9dafa891a2cd21))

# [1.7.0](https://github.com/ibrahimshadev/dikt/compare/v1.6.0...v1.7.0) (2026-02-04)


### Features

* **settings:** add hold vs lock recording mode toggle ([94c1e17](https://github.com/ibrahimshadev/dikt/commit/94c1e1780429a33aa6c3f8d78018540ab45116bd))

# [1.6.0](https://github.com/ibrahimshadev/dikt/compare/v1.5.0...v1.6.0) (2026-02-04)


### Bug Fixes

* **ui:** eliminate tab switch flicker and refine pill appearance ([fa90fa5](https://github.com/ibrahimshadev/dikt/commit/fa90fa56d4e089089a96505c272332405e601a04))


### Features

* addded vocabulary support ([e23ce08](https://github.com/ibrahimshadev/dikt/commit/e23ce08e6e62dc3cfcfcf9321d102b917d2ee85a))

# [1.5.0](https://github.com/ibrahimshadev/dikt/compare/v1.4.1...v1.5.0) (2026-02-04)


### Features

* **ui:** make settings panel height dynamic with smooth animations ([c9d6d6d](https://github.com/ibrahimshadev/dikt/commit/c9d6d6d47c79d64c4895214736cdfc8ba84ee01d))

## [1.4.1](https://github.com/ibrahimshadev/dikt/compare/v1.4.0...v1.4.1) (2026-02-03)


### Bug Fixes

* **ui:** adjust settings panel bottom offset to prevent header cutoff ([410b7f4](https://github.com/ibrahimshadev/dikt/commit/410b7f40b6ea29d0b258021653d52b1b61a3204d))
* **ui:** position settings panel absolutely to prevent hiding pill ([d66d4e1](https://github.com/ibrahimshadev/dikt/commit/d66d4e1802c7da9e457809ef08c93862be84de9e))

# [1.4.0](https://github.com/ibrahimshadev/dikt/compare/v1.3.1...v1.4.0) (2026-02-03)


### Bug Fixes

* **ui:** increase expanded height to show buttons and pill ([190487a](https://github.com/ibrahimshadev/dikt/commit/190487ab1e797462f93aac95bcdd8ad9a4053633))


### Features

* **ui:** add closing animation to settings panel ([5db1de3](https://github.com/ibrahimshadev/dikt/commit/5db1de3146b0cb768f3d49ea3f40b3b7fb61abd1))

## [1.3.1](https://github.com/ibrahimshadev/dikt/compare/v1.3.0...v1.3.1) (2026-02-03)


### Bug Fixes

* **ui:** increase expanded height to show buttons and pill ([97d4c15](https://github.com/ibrahimshadev/dikt/commit/97d4c15ff8337e13db413776e163257626686c2e))

# [1.3.0](https://github.com/ibrahimshadev/dikt/compare/v1.2.0...v1.3.0) (2026-02-03)


### Bug Fixes

*  API key is resetting on app close fixed ([2c203fc](https://github.com/ibrahimshadev/dikt/commit/2c203fccae5f3691040af569bf42e43757d72fd4))


### Features

* **ui:** expand settings panel from pill position ([ae3d48d](https://github.com/ibrahimshadev/dikt/commit/ae3d48d704e5183a4209daf29c1263a90440248d))

# [1.2.0](https://github.com/ibrahimshadev/dikt/compare/v1.1.10...v1.2.0) (2026-02-03)


### Features

* **settings:** add provider presets and model selector ([e35b9cc](https://github.com/ibrahimshadev/dikt/commit/e35b9cc47c05dacb6ed82f4f73a9a079905923c6))

## [1.1.10](https://github.com/ibrahimshadev/dikt/compare/v1.1.9...v1.1.10) (2026-02-03)


### Bug Fixes

* **ci:** move push trigger from build to release workflow ([3af74d3](https://github.com/ibrahimshadev/dikt/commit/3af74d3fbc50c5aa2cf4cbbeec21c6eaf58bab20))
* **recording:** set status synchronously to prevent race condition ([d0e6df8](https://github.com/ibrahimshadev/dikt/commit/d0e6df8d03715118895fe0d6d2b75e09b3b9d75f))
* trigger release test ([50961dc](https://github.com/ibrahimshadev/dikt/commit/50961dc6628dac849d95adcc942516641f93262a))

## [1.1.9](https://github.com/ibrahimshadev/dikt/compare/v1.1.8...v1.1.9) (2026-02-03)


### Bug Fixes

* **hotkey:** use CommandOrControl for cross-platform compatibility ([640e66c](https://github.com/ibrahimshadev/dikt/commit/640e66cc56e88bb5b2f7d4fcc6f05fc727696a3d))

## [1.1.8](https://github.com/ibrahimshadev/dikt/compare/v1.1.7...v1.1.8) (2026-02-03)


### Bug Fixes

* **ci:** run build workflow on push and fix Win32 API cal ([67396d8](https://github.com/ibrahimshadev/dikt/commit/67396d8d9c4ddbdec8008d84e76520411f2a06ca))

## [1.1.7](https://github.com/ibrahimshadev/dikt/compare/v1.1.6...v1.1.7) (2026-02-03)


### Bug Fixes

* **ci:** fix release asset upload permissions ([339e46a](https://github.com/ibrahimshadev/dikt/commit/339e46a5be3a145dde17f4a33d767f3abe6bef2e))

## [1.1.6](https://github.com/ibrahimshadev/dikt/compare/v1.1.5...v1.1.6) (2026-02-03)


### Bug Fixes

* **ui:** increase window height to prevent content clipping ([4d6b42d](https://github.com/ibrahimshadev/dikt/commit/4d6b42dbf71566c7ae9a29df1336b6d0719ed88e))

## [1.1.5](https://github.com/ibrahimshadev/dikt/compare/v1.1.4...v1.1.5) (2026-02-03)


### Bug Fixes

* **settings:** fix borrow after move error in load_settings ([48edabb](https://github.com/ibrahimshadev/dikt/commit/48edabbcca359c7ee12cc38c9b0a8d3c2d08c115))

## [1.1.4](https://github.com/ibrahimshadev/dikt/compare/v1.1.3...v1.1.4) (2026-02-03)


### Bug Fixes

* **ci:** add macOS icon generation to release workflow ([a3f77d3](https://github.com/ibrahimshadev/dikt/commit/a3f77d3bd8faa44753e58ce2821d8ce6f42be768))

## [1.1.3](https://github.com/ibrahimshadev/dikt/compare/v1.1.2...v1.1.3) (2026-02-03)


### Bug Fixes

* **ui:** fix transparent window on Windows and change default hotkey ([a6ca22a](https://github.com/ibrahimshadev/dikt/commit/a6ca22aedd68420a5c1bfe2137b4da17a4a25641))

## [1.1.2](https://github.com/ibrahimshadev/dikt/compare/v1.1.1...v1.1.2) (2026-02-03)


### Bug Fixes

* **ui:** fix glassmorphism backdrop and window dragging on Windows ([aabb8af](https://github.com/ibrahimshadev/dikt/commit/aabb8affe8531ebe327645dc60e9211cbb08093c))

## [1.1.1](https://github.com/ibrahimshadev/dikt/compare/v1.1.0...v1.1.1) (2026-02-03)


### Bug Fixes

* **ci:** use semantic-release-action for proper output exports ([c5e3ba7](https://github.com/ibrahimshadev/dikt/commit/c5e3ba77819cc8a619c0cce6c49bd256849701e8))

# [1.1.0](https://github.com/ibrahimshadev/dikt/compare/v1.0.0...v1.1.0) (2026-02-03)


### Features

* **ci:** enable macOS builds and upload artifacts to releases ([5bec11d](https://github.com/ibrahimshadev/dikt/commit/5bec11d9b7d5018744c1389d537e276139eddca7))

# 1.0.0 (2026-02-03)


### Bug Fixes

* **ci:** add write permissions for semantic-release ([c2e2c59](https://github.com/ibrahimshadev/dikt/commit/c2e2c59732a7ae42fc6bbe3f2a1d61a2abb78baa))
* **ui:** widen settings panel and improve input styling ([40fb48b](https://github.com/ibrahimshadev/dikt/commit/40fb48b15726d3609bf22d4c9036c40c2fd9ea4b))


### Features

* **ui:** add draggable pill and fix taskbar overlap ([a47b8f0](https://github.com/ibrahimshadev/dikt/commit/a47b8f0e73920c512bcb1ac25f05884345244081))
* **ui:** redesign floating window as bottom-centered pill with tray ([b4f8eb7](https://github.com/ibrahimshadev/dikt/commit/b4f8eb74b70087c7afc157a9f218e0d8ba713d48))
* **ui:** redesign pill to minimal idle state with hover expansion ([27c310a](https://github.com/ibrahimshadev/dikt/commit/27c310af43af96e8eb16d90980b63c5782fe41af))

# Changelog

All notable changes to this project will be documented in this file.

This changelog is automatically generated by [semantic-release](https://github.com/semantic-release/semantic-release).
