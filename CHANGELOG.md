# Changelog

## [0.4.0](https://github.com/SphericalKat/wheatley/compare/v0.3.0...v0.4.0) (2026-11-27)


### Features

* add /model pickers for the CLI, chat Frontends, and dashboard ([191986b](https://github.com/SphericalKat/wheatley/commit/191986b45cc094f6fc7d7b4984f8f63b9dc913e1))
* adopt focused ESM libraries for CLI, Markdown, HTTP servers, semver, and dashboard routing ([f1bd372](https://github.com/SphericalKat/wheatley/commit/f1bd3728df701f350d5213dd62345bb93c8d4988))
* **cli:** add interactive /model picker in the Ink TUI ([8e75190](https://github.com/SphericalKat/wheatley/commit/8e751903356c2bc6287f5cf42344778b85529ede)), closes [#112](https://github.com/SphericalKat/wheatley/issues/112)
* **cli:** default bare wheatley to chat and auto-start ephemeral daemon ([2840940](https://github.com/SphericalKat/wheatley/commit/2840940aa0a787a919d5191de6fd3bc831c0af9d))
* **cli:** show source diagnostics for an invalid config.yaml ([eba4d66](https://github.com/SphericalKat/wheatley/commit/eba4d66f5392f356286da82f2cb8d8fc2269a721))
* **cli:** show source diagnostics for an invalid config.yaml ([22ce68c](https://github.com/SphericalKat/wheatley/commit/22ce68ceb1601b1a94ba7e457ce245500f2486b4))
* **dashboard:** add model picker using models.list ([b4ff3dc](https://github.com/SphericalKat/wheatley/commit/b4ff3dc97214c6050e622a39bc9487a1ea055cb3))
* **discord:** add native /model picker ([571d5bb](https://github.com/SphericalKat/wheatley/commit/571d5bbe1ac11d800b47af8398d598e0fbbf974e))
* **docs:** add Starlight documentation site package ([7f8e088](https://github.com/SphericalKat/wheatley/commit/7f8e088e27393f4759c4bb2701143aaa88943988))
* **docs:** add Starlight documentation site package ([e42113f](https://github.com/SphericalKat/wheatley/commit/e42113fa6f5a7d747c61708983f0f82631c23990))
* list available models when /model has no argument ([804ccbf](https://github.com/SphericalKat/wheatley/commit/804ccbff1844ee032df37bfbdd3778202b1d1eae))
* **slack:** add native /model picker ([a8cea8a](https://github.com/SphericalKat/wheatley/commit/a8cea8a4af0299efbb23e296e86f330333a1dc2a))
* **telegram:** add native /model picker ([d47098f](https://github.com/SphericalKat/wheatley/commit/d47098f24d16e2f5f92a23a2ad0f3599fbec4577))


### Bug Fixes

* **cli:** remove the help subcommand that commander adds ([21eb86d](https://github.com/SphericalKat/wheatley/commit/21eb86d0cfa5640d53cb08bed690a995ca6bd312))
* **docs:** fix broken Starlight steps and callouts from oxfmt ([43b7d04](https://github.com/SphericalKat/wheatley/commit/43b7d04767b4e683f98ec7b174ec002aad606ae5))
* **docs:** fix broken Starlight steps and callouts from oxfmt ([a21c11f](https://github.com/SphericalKat/wheatley/commit/a21c11f0bbac2e7efda795ff15054060e6625b29))
* **docs:** include astro/client types in tsconfig for clean-checkout linting ([01c7ca5](https://github.com/SphericalKat/wheatley/commit/01c7ca5e1cfba32a951042693432028402fafd82))
* **http:** answer 400 for an unreadable webhook body and share the Hono listener setup ([3e34a87](https://github.com/SphericalKat/wheatley/commit/3e34a870ef202834b4bad75697ff6c69cec63888))
* **http:** serve a dashboard folder that appears after the daemon starts ([af46d84](https://github.com/SphericalKat/wheatley/commit/af46d848dcfc94d43c37fe554c3d5cad317a7112))
* **markdown:** resolve streamed reference links against definitions that arrive later ([635123a](https://github.com/SphericalKat/wheatley/commit/635123a3de39010eabcf1e08799cb73d1046bb9d))
* **release:** serve the CLI tarball from GitHub releases for Homebrew and AUR ([d6fe38c](https://github.com/SphericalKat/wheatley/commit/d6fe38ca1d73bebe7d49ced91ae055b3c91fd053))
* **release:** serve the CLI tarball from GitHub releases for Homebrew and AUR ([899742c](https://github.com/SphericalKat/wheatley/commit/899742c1ffc3b5acd52db882915e39b8eb13b6db))
* **service:** do not quote WorkingDirectory in systemd unit ([fc88e4e](https://github.com/SphericalKat/wheatley/commit/fc88e4ea94e4a448cff8d62c4401a705c158b9ae))
* **service:** do not quote WorkingDirectory in systemd unit ([0473282](https://github.com/SphericalKat/wheatley/commit/04732824b94bfb552cb6e00e1f9df6883cf5e193))

## [0.3.0](https://github.com/SphericalKat/wheatley/compare/v0.2.0...v0.3.0) (2026-11-27)


### Features

* add curl installer with XDG layout and managed Node.js runtime ([481e74a](https://github.com/SphericalKat/wheatley/commit/481e74a88229dd9c780baf5c15b7c82c5d956917))
* add curl installer with XDG layout and managed Node.js runtime ([f5df269](https://github.com/SphericalKat/wheatley/commit/f5df269c2ded59f607442126fdfb1a7d2fd4c12a)), closes [#87](https://github.com/SphericalKat/wheatley/issues/87)
* publish the wheatley Homebrew formula on release ([8d26bfb](https://github.com/SphericalKat/wheatley/commit/8d26bfbbcc01870d5b6fe1de440bbd239600c9bd))
* publish the wheatley Homebrew formula on release ([6acbf5a](https://github.com/SphericalKat/wheatley/commit/6acbf5ad1f7ea7f95765aae7965442ab0592654c)), closes [#88](https://github.com/SphericalKat/wheatley/issues/88)
* publish wheatley-cli AUR package on release ([8eaa022](https://github.com/SphericalKat/wheatley/commit/8eaa022fd53a496fe0b04b222884e8a297327e83))
* publish wheatley-cli AUR package on release ([7e2b36d](https://github.com/SphericalKat/wheatley/commit/7e2b36db493ccac9bcd73db9f18c7968fb53342f)), closes [#89](https://github.com/SphericalKat/wheatley/issues/89)


### Bug Fixes

* **deps:** update dependency string-width to v9 ([1e85020](https://github.com/SphericalKat/wheatley/commit/1e8502067a6219f032e5a6754d54cf1f15800544))
* **deps:** update dependency string-width to v9 ([6394d59](https://github.com/SphericalKat/wheatley/commit/6394d590800fab063a69bd8b434e7df3cdadd1c9))
* detect install methods and look up versions over HTTP in wheatley update ([5046a3c](https://github.com/SphericalKat/wheatley/commit/5046a3c7bbd48e18c43ffc5d7ae339fa823aa945))
* fail curl updates on download errors and keep path hints first ([c8fa166](https://github.com/SphericalKat/wheatley/commit/c8fa1661f7d1c5d038ed83f41b9020b261d1f690))
* overhaul wheatley update for flexible package managers and HTTP version lookup ([13e687c](https://github.com/SphericalKat/wheatley/commit/13e687c23d04e3aca8664e38b93b1d52c8264f53))
* read the Homebrew tarball URL from the formula ([cfa75db](https://github.com/SphericalKat/wheatley/commit/cfa75dbbb64a34cfd07956cfb10ac6ac7c31833e))

## [0.2.0](https://github.com/SphericalKat/wheatley/compare/v0.1.1...v0.2.0) (2026-11-26)


### Features

* **cli:** add a banner, a live command menu, and rotating thinking lines to wheatley chat ([891ee0b](https://github.com/SphericalKat/wheatley/commit/891ee0bbe2f940dea7abf08332256b502d9f7a77))
* **cli:** rebuild the wheatley chat terminal with Ink ([aa41bf1](https://github.com/SphericalKat/wheatley/commit/aa41bf19e6abe6a534c138a6e2f218e05080f167))
* **cli:** rebuild the wheatley chat terminal with Ink ([0895456](https://github.com/SphericalKat/wheatley/commit/0895456d3565a1bc96157c8d3fc73826cc14b12a))

## [0.1.1](https://github.com/SphericalKat/wheatley/compare/v0.1.0...v0.1.1) (2026-11-25)


### Bug Fixes

* **ci:** keep oxfmt off the release-please CHANGELOG.md ([4dcf961](https://github.com/SphericalKat/wheatley/commit/4dcf961c99ee628f9c88775ab5657275eea9806a))

## 0.1.0 (2026-11-25)


### ⚠ BREAKING CHANGES

* move the workspace packages to the @wheatley-ai npm scope

### Features

* add the pnpm workspace with frozen v1 protocol, SDK, and seam contracts ([9b42d6a](https://github.com/SphericalKat/wheatley/commit/9b42d6a23b6fdab6b23830052fdc78b46c1ffc9d))
* **approvals:** add durable ApprovalGate, permission policy, and CLI approval prompt ([cde5681](https://github.com/SphericalKat/wheatley/commit/cde5681cd441d89b9c497a4c9951a564da655cea))
* **approvals:** add durable ApprovalGate, permission policy, and CLI approval prompt ([ed98deb](https://github.com/SphericalKat/wheatley/commit/ed98deb21e5cc39618a3259333208f24d9fb5fc9))
* **cli:** add init, daemon, chat, ask, and status commands ([9f7ddac](https://github.com/SphericalKat/wheatley/commit/9f7ddacb4cff7faacabbd1317ecc356544f223f6))
* close Wave 1 seam gaps in the frozen protocol, SDK, and contracts ([d541319](https://github.com/SphericalKat/wheatley/commit/d5413195270bc807912d0d803923a1a3eef8639e))
* convert to a pnpm workspace with frozen v1 protocol and SDK contracts ([0191c4e](https://github.com/SphericalKat/wheatley/commit/0191c4e91a27977bd324068b1232f69cf4f2731e))
* **core:** add ConfigStore, Deployment, Supervisor, Agent, and Control Server ([c001583](https://github.com/SphericalKat/wheatley/commit/c001583d9c098d577e660b3e6ac1167db9cfca36))
* **core:** add the core runtime, Control Server, CLI, and built-in Tools ([eb58198](https://github.com/SphericalKat/wheatley/commit/eb58198eaf4648ad09b2b25b904075f7a52a7453))
* **dashboard:** add the monitoring and configuration dashboard SPA ([4ee5f83](https://github.com/SphericalKat/wheatley/commit/4ee5f83f75a3f35bdb08e7e2f3339e8f9b2dc213))
* **dashboard:** add the monitoring and configuration dashboard SPA ([0e1fbe8](https://github.com/SphericalKat/wheatley/commit/0e1fbe83a9145d748b581706e9bc10d453b5d188))
* **frontend-discord:** add the built-in Discord Frontend binding ([db3a987](https://github.com/SphericalKat/wheatley/commit/db3a9873fe1c4acc8a54ea5b5074da66d94a5a6b))
* **frontend-discord:** add the built-in Discord Frontend binding ([f39a0b7](https://github.com/SphericalKat/wheatley/commit/f39a0b733b96bd1f302052931f68c075990f30bb))
* **frontends:** add the built-in Slack Frontend ([3569d8e](https://github.com/SphericalKat/wheatley/commit/3569d8ec9c89c12086c0899b9cad5775c56d1aaf))
* **frontends:** add the built-in Slack Frontend binding ([07fcc45](https://github.com/SphericalKat/wheatley/commit/07fcc45c83ca9bbc5ff3da16e46c4993e6f264e0))
* **mcp:** add MCP Server client manager for stdio and Streamable HTTP ([156a468](https://github.com/SphericalKat/wheatley/commit/156a4689eb78f82d0e5d9431daac7b33f7a8a55c))
* **mcp:** add MCP Server client manager for stdio and Streamable HTTP ([58bb314](https://github.com/SphericalKat/wheatley/commit/58bb314f24864f90eb121a5e5d809017dc688dbe))
* **memory:** add Markdown Memory with FTS5 index, Tools, snapshots, and consolidation ([9c07b51](https://github.com/SphericalKat/wheatley/commit/9c07b5151f8a2d4210bf7cfd6024399f75014b95))
* **memory:** add Markdown Memory with FTS5 index, Tools, snapshots, and consolidation ([b439db5](https://github.com/SphericalKat/wheatley/commit/b439db52a8bf10e36131aa9aa3d881162db391f8))
* **ops:** add service units, pre-migration backups, restore, and update guard ([fba9464](https://github.com/SphericalKat/wheatley/commit/fba9464d1b8e5b35238252b62ea83d4f0d39a440))
* **ops:** add service units, pre-migration backups, restore, update guard, and Docker image ([f36c245](https://github.com/SphericalKat/wheatley/commit/f36c245c94988e7083a74542058b806ce8ff4826))
* **packaging:** add npm bin entry, dashboard asset hook, and Docker Compose image ([c391dd1](https://github.com/SphericalKat/wheatley/commit/c391dd19be7cbc21581b6d54f59730c4523b3b25))
* **plugins:** add in-process Plugin loader with isolated load failures ([18d7795](https://github.com/SphericalKat/wheatley/commit/18d7795b2657a9dd146183ea7ee6e7af574bd664))
* **plugins:** add in-process Plugin loader with isolated load failures ([5783a8e](https://github.com/SphericalKat/wheatley/commit/5783a8e45bf6eb0e2298ce59f425d848e74e7814))
* **skills:** add the 3-tier Agent Skills catalog and loader ([c7e5cd8](https://github.com/SphericalKat/wheatley/commit/c7e5cd82ab10483f79a553f3f32a4c39df935045))
* **skills:** add the 3-tier Agent Skills catalog and loader ([4d98315](https://github.com/SphericalKat/wheatley/commit/4d98315b080e57e63f163f83f93587516318ee23))
* **telegram:** add the built-in Telegram frontend ([f062c08](https://github.com/SphericalKat/wheatley/commit/f062c08510419b313b741feda6630e997ec66734))
* **telegram:** add the built-in Telegram frontend binding ([eee7946](https://github.com/SphericalKat/wheatley/commit/eee7946f6e90f7507913010a7adfb9901024bfea))
* **tools:** add built-in read_file, write_file, and shell Tools ([189a626](https://github.com/SphericalKat/wheatley/commit/189a62657c20fc8ec0da8cc61ccac35dd8b22f73))
* **triggers:** add Trigger runtime, Delivery Outbox, and Webhook Ingress ([20e9a9d](https://github.com/SphericalKat/wheatley/commit/20e9a9dc53a3b17f165c1a28db7d121cf291ab60))
* **triggers:** add Trigger runtime, Delivery Outbox, and Webhook Ingress ([8d08815](https://github.com/SphericalKat/wheatley/commit/8d08815d5efc1ef5c5a9ad3a089c90e69601cebe))
* **wheatley:** add seam contracts, in-memory fakes, and a pi-durable smoke test ([530e7dc](https://github.com/SphericalKat/wheatley/commit/530e7dc5f6ca407e7c0ebb7a75e12148d23c90d2))
* **wheatley:** add the agent.sqlite migration runner ([1e8fa1a](https://github.com/SphericalKat/wheatley/commit/1e8fa1a51f80fdb37fa7f5d891e985604206041a))
* wire the v1 modules into the Deployment and pass the Wave 2 E2E gate ([76cd7fe](https://github.com/SphericalKat/wheatley/commit/76cd7feaa5c3f5ff1ea13b95be25d939a3352d11))
* wire v1 modules into the Deployment, serve the dashboard, and add the E2E harness ([e1e9d41](https://github.com/SphericalKat/wheatley/commit/e1e9d41466bbfae5aa96744737c0361e0ad2786e))


### Bug Fixes

* address local-testing findings in Triggers, CLI, daemon, and dashboard ([da4331e](https://github.com/SphericalKat/wheatley/commit/da4331e19ab36f724b1b1c9356cd5e39c9ca8902))
* **approvals:** deny woken calls after /stop and reject decide on a failed config.yaml write ([d7a4a64](https://github.com/SphericalKat/wheatley/commit/d7a4a6496f1880d158d15489485eebce474902cc))
* **ci:** make 0.1.0 the first release-please version ([7c3eade](https://github.com/SphericalKat/wheatley/commit/7c3eadeb526fb6d73c55c49da329f60398354b04))
* **ci:** make 0.1.0 the first release-please version ([a22584c](https://github.com/SphericalKat/wheatley/commit/a22584c49c0f3f39ef8e6273ebe49d614c70a10d))
* **cli:** honor --home for service, update, and restore, and add --help ([b60675c](https://github.com/SphericalKat/wheatley/commit/b60675c41358759b068d45333a478ebb7dc5f74e))
* **cli:** remove the answered Approval by ID in wheatley chat ([41f9149](https://github.com/SphericalKat/wheatley/commit/41f914917ac4cd568af1653f0395021507d1d80c))
* **cli:** send a boolean interactive flag when stdin is not a terminal ([72f7a20](https://github.com/SphericalKat/wheatley/commit/72f7a202feebe98727b4da3bab0c8eb3f3f6f83a))
* **cli:** send a boolean interactive flag when stdin is not a terminal ([30afd1c](https://github.com/SphericalKat/wheatley/commit/30afd1c855e035356e4369de98478b8e2515d3fd))
* **contracts:** address review findings on seam docs, limits, and fakes ([ceaade9](https://github.com/SphericalKat/wheatley/commit/ceaade9b6d58290116816a8780e122c0b30341a7))
* **core:** add delivered Trigger results to the target Chat's model context ([a50a609](https://github.com/SphericalKat/wheatley/commit/a50a60918f7bca81bee0b11f89ce1cfc809e5b04))
* **core:** apply the Wave 2 review fixes to the Agent, daemon, and Memory wiring ([0f16892](https://github.com/SphericalKat/wheatley/commit/0f16892559afc8c4c3d5f72faa35f782b8f61994))
* **core:** flush Memory before automatic compaction, stream run deltas, and archive messages ([ebb1e97](https://github.com/SphericalKat/wheatley/commit/ebb1e979a67a448f96c1a791c8dadb287bcf1b8e))
* **core:** reply to every slash command, including usage and /stop results ([fd193df](https://github.com/SphericalKat/wheatley/commit/fd193df910262de25166bc7efa0f39a7a0e416f5))
* **core:** state the /goal exception to the one-reply rule and narrow the CLI test ([df297dd](https://github.com/SphericalKat/wheatley/commit/df297dd90106e055a01366dbf92fbbadcbc46d55))
* **daemon:** choose the fallback socket folder from the file system and resolve home symlinks ([478a205](https://github.com/SphericalKat/wheatley/commit/478a205c5efd08081bea672a531a68438a82c2bd))
* **daemon:** use a short socket path when the home path is too long for a Unix socket ([2cdac77](https://github.com/SphericalKat/wheatley/commit/2cdac77b8dfeea73be982099f9fb49a3312785cd))
* **daemon:** wait for a starting or restarting Agent before Agent requests ([fe5bf34](https://github.com/SphericalKat/wheatley/commit/fe5bf349672a5e86c0669660254ebdb90e6b6a9e))
* **dashboard:** share webhook defaults and path with the daemon, and resolve wildcard ingress hosts ([c44a8b1](https://github.com/SphericalKat/wheatley/commit/c44a8b17c0f57717a1993f609417e33da9e3eace))
* **dashboard:** show Trigger IDs and webhook URLs, inline Chat Approvals, and ship a favicon ([148e2ab](https://github.com/SphericalKat/wheatley/commit/148e2abd13876a85174c467cf5f1818bc589ce71))
* **db:** keep foreign keys, deny self-commit, and skip concurrent migrations ([4dbc184](https://github.com/SphericalKat/wheatley/commit/4dbc184103e9090113bd867dd56ca6995c68e6f0))
* **deps:** update dependency grammy to v1.48.0 ([548cff7](https://github.com/SphericalKat/wheatley/commit/548cff7924b4e8932efb61bcf04b04f12b381299))
* **deps:** update dependency grammy to v1.48.0 ([7b4c15f](https://github.com/SphericalKat/wheatley/commit/7b4c15fc73b4cf4f8469832a4a7de532b632fdc1))
* **frontend-discord:** address review findings on seam docs, duplication, and adapter tests ([275ba77](https://github.com/SphericalKat/wheatley/commit/275ba7714fd527119e7cf093c2fceb6036211af7))
* **frontends:** address review findings on the Slack Frontend ([6d804f8](https://github.com/SphericalKat/wheatley/commit/6d804f82923e3e3226ed7ff78e389fdc12e16792))
* **mcp:** address review findings on TSDoc, defaults, and version lookup ([7879a45](https://github.com/SphericalKat/wheatley/commit/7879a45842ea9c0a33585e45ed5a09f568385894))
* **memory:** address review findings on seam errors, row checks, and disabled schedules ([df78393](https://github.com/SphericalKat/wheatley/commit/df7839321d28b3cb460f6ea410848819ab2381bc))
* **ops:** address review findings on isolation, error codes, and shared helpers ([a0d7e36](https://github.com/SphericalKat/wheatley/commit/a0d7e3642c4b33c7c8d53b3a5d6f5218170f2cb5))
* **ops:** document restore exit codes and cover usage errors in tests ([4292365](https://github.com/SphericalKat/wheatley/commit/429236576aa710d14e966dc0ec77d43a814315f5))
* **ops:** list restore backups on stdout with exit 0 when no backup is named ([88af60b](https://github.com/SphericalKat/wheatley/commit/88af60b0aa3fb455e55a36cb0506b59350e85756))
* **plugins:** await late setup disposals on close and address review findings ([78614d0](https://github.com/SphericalKat/wheatley/commit/78614d0dd19e4dc7f5b4a197b7ae1db526bfce93))
* **skills:** address review findings on tests, ordering, and the read_skill name ([dcf9702](https://github.com/SphericalKat/wheatley/commit/dcf97027f5a038ed447ffef391391564ca8b70b9))
* **telegram:** accept an optional bot username from grammY getMe ([9d197c0](https://github.com/SphericalKat/wheatley/commit/9d197c0921d20f49b81832824ecd5f3a6e982652))
* **triggers:** reject schedule_trigger targets on unknown Frontend Bindings ([f985ec2](https://github.com/SphericalKat/wheatley/commit/f985ec2a2230e2fdb4c7ec01bccb0c34735bea3a))
* **triggers:** retry failed once starts and share timer and error helpers ([b9e8f6e](https://github.com/SphericalKat/wheatley/commit/b9e8f6ec0a7accd90132270462b6ac8abc866caa))


### Reverts

* update @types/node to v26.6.10 ([#4](https://github.com/SphericalKat/wheatley/issues/4)) ([1ac4d7f](https://github.com/SphericalKat/wheatley/commit/1ac4d7fe843be471e67d5512ac614f245d11fa25))


### Code Refactoring

* move the workspace packages to the [@wheatley-ai](https://github.com/wheatley-ai) npm scope ([d90f149](https://github.com/SphericalKat/wheatley/commit/d90f149e90f5c084acfa34dd9a530d96486c7ebb))
