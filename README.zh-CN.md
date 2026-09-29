# Vivado for VS Code

[English](README.md) | 简体中文

面向 Verilog/SystemVerilog 开发的本地优先 VS Code 扩展，调用计算机上已安装的 Vivado 工具链。初始验证环境为 Windows 和 Vivado 2018.3。语法高亮由配套扩展 `mshr-h.veriloghdl` 提供，本扩展不重复注册语言 ID。

在编辑器中完成工程管理、实时诊断、综合、实现、仿真与波形预览、综合网表预览、I/O 引脚规划，以及对已连接 FPGA 的编程。

**预览状态：** 当前 `0.4.2` 用于本地试用，未经过完整调试，只建议非工业级开发者使用。当前开发进度可能由开发者课程进度决定，可参考 SUSTech 的 digital logic 课程实验。

## 目录

- [Vivado for VS Code](#vivado-for-vs-code)
  - [目录](#目录)
  - [环境要求](#环境要求)
  - [安装](#安装)
  - [快速开始](#快速开始)
  - [工程配置](#工程配置)
  - [主要工作流](#主要工作流)
  - [I/O 规划](#io-规划)
  - [设置](#设置)
  - [安全与隐私](#安全与隐私)
  - [常见问题](#常见问题)
  - [当前限制](#当前限制)
  - [许可证](#许可证)

## 环境要求

- 桌面版 VS Code `1.90.0` 或更新版本，以扩展清单声明为准。
- 单独安装的 Vivado，包含 `vivado`、`xvlog`、`xelab`、`xsim` 和目标器件支持。扩展不附带 Vivado。
- 已信任、使用本地文件系统的工作区。不支持纯浏览器版 VS Code 或虚拟工作区。
- 初始测试环境为 Windows + Vivado 2018.3。Linux 和其他 Vivado 版本尚未完成兼容性验证；不支持将 macOS 作为工具链运行主机。
- FPGA 编程另需兼容且已连接的开发板、线缆驱动和可访问的 `hw_server`。
- 仅从源码构建本扩展时需要 Node.js 22 或更新版本、npm，以及 Rust 1.85.1（含 `rust-src` 和 `wasm32-unknown-unknown`）。直接安装 VSIX 不需要 Rust。

## 安装

如需在本地试用，可从仓库源码构建 VSIX。请先按 [WASM 构建说明](wasm/README.md) 安装固定版本的 Rust 工具链：

```sh
npm ci
npm run check
npm test
npm run package
```

在 VS Code 命令面板执行 **Extensions: Install from VSIX...**（从 VSIX 安装），选择 `vivado-for-vscode-0.4.2.vsix`。也可以执行：

```sh
code --install-extension ./vivado-for-vscode-0.4.2.vsix
```

`mshr-h.veriloghdl` 是提供 Verilog、SystemVerilog 和 XDC 高亮的必需依赖，请先安装并启用；离线安装时也需要它的 VSIX。升级后执行 **Developer: Reload Window**（重新加载窗口）。本项目不捆绑该扩展的代码，也不提供 Vivado 安装程序。

体验示例时，请将源码仓库中的 [`examples/counter`](examples/counter) 单独打开为工作区，不要打开仓库根目录。示例和开发、测试产物不会打入 VSIX。

示例 XDC 只是 `xc7a35tcsg324-1` 工具流程测试样例，**不是经过验证的开发板模板**。编程前必须根据实际开发板核对每个引脚及配置电压。

## 快速开始

1. 安装 VSIX，并打开可信的本地工程文件夹。
2. 将 `vivado.installPath` 设置为你的 Vivado 版本目录，例如 `C:/Xilinx/Vivado/2018.3`。未配置时依次检查 `XILINX_VIVADO`、PATH 和常见安装目录。
3. 执行 **Vivado: New Project**，输入项目名、选择父目录、已安装器件和顶层模块；插件会创建新的项目子目录，不覆盖已有目录。也可用 **Vivado: Import XPR Project** 导入，或用 **Vivado: Open Project** 选择已有的 `vivado-project.json`。
4. 在 Vivado 侧栏点击 **New Source / Simulation / Constraints File**，或源文件分组旁的新建文件图标，选择 `.v`、`.sv` 或 `.xdc` 文件名。插件自动创建、加入工程、填写 Vivado 风格注释和对应模块名，并打开编辑器；已有文件使用 **Add Existing File to Project**。也可在源文件右键菜单中设置设计顶层或仿真顶层。
5. 点击 HDL 编辑器右上角的运行按钮执行仿真；旁边的菜单提供综合、实现、生成比特流和预览。运行时按钮变为停止。

状态栏显示检测到的 Vivado 版本；诊断进入 Problems（问题）面板；工具输出进入 Vivado Output（输出）通道，仿真输出还会显示在终端中。进度通知和状态栏支持取消操作。

项目右键菜单、侧栏菜单和 Run 菜单提供 **Vivado: Close Project**。关闭会停止该项目的任务、关闭其 Tcl Console 和预览、清除诊断，但不删除文件，也不关闭未保存的源码编辑器；未保存的 I/O 表格编辑会在确认后丢弃。刷新或重载后项目仍保持关闭，可通过 **Open Project** 重新打开。嵌套项目和导入的工作区外源码也能识别所属项目。

为避免配套高亮扩展重复报告诊断，可自行设置 `verilog.linting.linter` 为 `none`。本扩展不会修改其他扩展的设置。

## 工程配置

每个项目目录包含一个 `vivado-project.json`，路径相对于该目录：

```json
{
  "version": 1,
  "name": "my_project",
  "part": "xc7a35tcsg324-1",
  "top": "top",
  "sources": ["rtl/packages.sv", "rtl/**/*.{v,sv,vh,svh}"],
  "constraints": ["constraints/**/*.xdc"],
  "simulation": ["sim/**/*.{v,sv}"],
  "simulationTop": "tb",
  "simulationRunTime": "1 us",
  "includeDirs": ["include"],
  "defines": ["WIDTH=4"],
  "exclude": []
}
```

路径默认相对于 `vivado-project.json` 所在目录，也允许绝对路径和工作区外文件引用。文件模式按声明顺序展开，每个模式内部排序并去重；SystemVerilog package 应放在使用它的文件之前。作为构建输入的存储器或数据文件也应放进 `sources`，以便内容变化使旧构建失效。

新建和导入工程显式设置 `"simulationRunTime": "1 us"`；已有工程可省略该项，优先级为 **工程 `simulationRunTime` > VS Code `vivado.sim.runTime` > `1 us`**。只有 testbench 会自行结束（例如调用 `$finish`），或准备手动取消时才使用 `"all"`。运行前会打印时长及其来源；设置变化只对下一次运行生效。

新建工程设置 `"projectDirectory": "."`，采用 Vivado 原生目录形式：

```text
<选择的位置>/my_project/
  vivado-project.json
  my_project.xpr
  my_project.srcs/
    sources_1/new/
    constrs_1/new/
    sim_1/new/
  .vivado/
```

Vivado 按需生成 `.runs`、`.cache` 等原生产物目录；新建工程的源文件模式指向对应的 `.srcs` 文件集。`projectDirectory` 可指定项目目录内部的相对路径。已有或导入的配置若没有该字段，仍使用 `.vivado/project`，不会自动搬动原文件。

扩展脚本、报告和仿真仍位于 `.vivado/scripts`、`.vivado/reports` 和 `.vivado/sim`。请在自己的版本控制中忽略 `.vivado/` 和 Vivado 生成的产物目录，但保留 `.srcs` 中的源码。从侧栏移除文件只修改配置和排除项，不会删除源文件；重新添加文件会移除对应的精确排除项。

XPR 导入保留文件引用、器件、顶层、包含路径和宏定义，不复制文件，也不完整迁移运行策略、自定义 Tcl 钩子、逐文件属性、库分配或额外文件集。导入后请检查配置和 Output 中的警告。

## 主要工作流

- **实时语法检查：** 默认在编辑停止 500 ms 后检查。未保存的源码和头文件复制到工作区专属临时快照；每次检查使用独立编译目录，默认最多并行两个进程，诊断映射回原文件。
- **跨模块检查：** 保存或空闲两秒后编译设计源码并展开设计顶层，默认 timescale 为 `1ns/1ps`。**Check Project** 先独立检查所有设计、仿真源文件，再进行展开。
- **构建：** **Synthesize**、**Implement**、**Generate Bitstream** 和 **Build All** 先同步文件集，再启动独立批处理进程。内容指纹和 Vivado 运行状态决定是否重置综合；重新实现前重置实现运行。失败或取消会使当前比特流状态失效。
- **报告：** **Show Reports** 显示资源利用率、WNS/TNS/WHS/THS 和 DRC。完整文本保留在 `.vivado/reports`；这些是最近一次已完成报告的快照，不是实时结果。
- **新建文件：** 侧栏可直接创建 Verilog/SystemVerilog 设计源文件、仿真文件和 XDC 约束。注释包含项目、器件、模块、创建日期及已检测到的工具版本；HDL 自动填写 `timescale`、`module` 和 `endmodule`，仿真模板包含基础时钟及以 `$finish` 结束的有限激励占位。首个设计文件自动设为设计顶层；未配置仿真顶层时，首个仿真文件自动设为仿真顶层。不会覆盖已有文件。
- **仿真：** 编译配置或发现的 testbench，使用 `glbl.v` 和已安装的 Xilinx 仿真库。每次使用新的编译目录，并清除旧的当前结果标记、波形视图和输出终端。默认运行 `1 us`；成功后生成 WDB、VCD，并在编辑器右侧打开内置波形。失败或取消后不会将上次波形继续显示为当前结果。
- **清除仿真缓存：** 项目右键菜单、侧栏菜单和 Run 菜单中的 **Vivado: Clear Simulation Cache** 删除 `.vivado/sim`（包括先前的 WDB、VCD），并清空仿真输出、诊断及预览，不删除源码、XPR 或构建结果。运行中需要先等待或取消；若外部 WDB 查看器占用文件，应先关闭查看器。清理后可直接重新仿真，无需关闭、重开项目。
- **波形预览：** **Preview Waveform to the Side** 重新打开当前成功的仿真结果，有效期截至下一次仿真尝试或清理缓存。支持信号筛选、显隐、缩放、时间游标及二进制、十六进制、无符号显示，保留信号别名和 X/Z 状态。波形区域内，**Ctrl + 滚轮向上/向下** 以指针为中心放大/缩小（1x 至 32x），**Shift + 滚轮向下/向上** 向右/向左滚动。普通滚轮保持原有行为，工具栏按钮仍可用。**Open WDB in Waveform Viewer** 使用原生 Vivado 查看器，**Open VCD** 保留外部编辑器工作流。
- **综合网表预览：** 综合成功后导出真实 primitive、端口和网络，并打开 **Preview Synthesized Schematic to the Side**。使用美式 ANSI 符号表示常见逻辑门、缓冲器、反相器、触发器、锁存器和多路选择器；LUT 根据实际 `INIT` 真值表识别，支持部分输入反相。复杂 LUT 和其他 primitive 保留带标签的功能块。支持平移、缩放、单元搜索和关联网络高亮。这不是原生 RTL 原理图或器件布局图；修改源码后需要重新综合。
- **I/O 规划：** 综合后，点击原理图端口、表格工具按钮或 **Vivado: I/O Planning**，在同一右侧编辑器组打开表格。引脚和 I/O 标准从实际器件查询；保存的约束供后续构建使用。
- **硬件编程：** **Program Device** 检查比特流是否与当前工程匹配，连接服务器，选择目标和器件，并在编程前请求确认。找不到目标时提供重试；实际编程需要开发板。
- **GUI 回退：** **Open Project in Vivado GUI** 先同步生成的工程。请关闭 GUI 工程后再从 VS Code 构建，避免两个应用同时修改它。持久工程设置应保存在 `vivado-project.json`。
- **Tcl Console：** **Vivado: Open Tcl Console** 打开真正可交互的 Vivado 终端，并载入同步后的 XPR。入口位于侧栏终端图标、项目右键菜单和 Run 菜单，重复执行会聚焦已有终端。可以输入 `get_files` 或 `get_property PART [current_project]` 等命令；它与只读 Output、仿真输出终端相互独立。自动操作前会提示关闭 Console 以释放工程。持久设置应写入 `vivado-project.json`，自动同步可能覆盖手动 Tcl 修改；**Close Tcl Console** 只关闭控制台，不关闭项目。

如果 **Program Device** 留有硬件连接，打开 Tcl Console 时会将连接从后台会话移交到终端，恢复服务器、已打开的目标和所选器件，不会重新烧录。此后输入 `disconnect_hw_server` 即可断开该连接。没有已有连接时不会自动连接，也不会接管独立 Vivado GUI 中的连接。重连失败会在终端中显示错误，但仍可继续输入 Tcl 命令。

构建、仿真和编程会在保存已修改工作区文件前询问；语法检查不保存文件。HDL 工具和约束可能执行代码，因此必须信任工作区。

## I/O 规划

1. 执行 **Vivado: Synthesize**。从 0.2 升级后需要重新综合一次，以导出符号属性和当前设计快照。
2. 打开 **Vivado: I/O Planning**，或点击原理图顶层端口选中对应行。
3. 手动输入 **Package Pin**，或使用行内列表图标。选择器按引脚名称、功能搜索，支持 bank 筛选，并标记已占用引脚；保留/电源引脚不会列出。表格显示方向、bank、引脚功能及 I/O 标准。
4. 选择适合开发板的 I/O 标准。无效引脚、重复分配、bank 或方向不支持的标准会阻止保存；未分配完整、同一 bank 标称电压混用会产生警告。
5. 点击 **Save Constraints**，选择项目目录内一个新的 `.xdc`，例如 `constraints/io-planning.xdc`。扩展自动在配置中记录 `"ioConstraints": "constraints/io-planning.xdc"`；文件不存在前不要手动添加这一字段。
6. 运行 **Implement** 或 **Generate Bitstream**，并在编程前检查 Vivado DRC 和开发板原理图。

指定的 `ioConstraints` 文件最后同步，设置 `PROCESSING_ORDER LATE`；即使它已匹配其他约束 glob 也只保留一份。它覆盖所列端口的引脚和 I/O 标准，不修改原始 XDC 或其时序约束。仅允许覆盖之前由 I/O 规划生成的文件，手写约束受到保护。可在保存前交换两个已占用引脚。

外部修改约束后使用 **Reload I/O Planning**；放弃未保存编辑前会请求确认。更换器件或顶层会锁定已打开的表格，直到重新综合并加载。保存前还会检查其他源码、约束变化，避免旧快照覆盖新配置。关闭标签页后不会保留未保存的表格编辑。

这是封装引脚规划，不是开发板电气签核工具。允许保存不完整草稿，但板级电压、差分配对、时钟布线、配置电压和时序仍需核验。Vivado 2018.3 在清除显式标准后可能报告一个实际默认 I/O 标准，这不代表它适合开发板。

## 设置

| 设置 | 默认值 |
| --- | --- |
| `vivado.installPath` | 自动检测 |
| `vivado.outputEncoding` | `utf8`；中文输出乱码时可选 `gbk` |
| `vivado.lint.onType` | `true` |
| `vivado.lint.debounceMs` | `500` |
| `vivado.lint.elaborate` | `onIdle`；另可选 `onSave` / `none` |
| `vivado.lint.maxParallel` | `2` |
| `vivado.build.jobs` | `4` |
| `vivado.sim.defaultTimescale` | `1ns/1ps` |
| `vivado.sim.runTime` | `1 us`；仅当工程未指定 `simulationRunTime` 时使用 |
| `vivado.hw.serverUrl` | `localhost:3121` |

## 安全与隐私

- 必须信任工作区。Vivado、HDL 和 XDC/Tcl 输入可以使用当前用户权限执行代码，扩展不是沙箱；请先审查陌生工程再授权。
- 配置允许绝对路径和工作区外引用，导入后应检查文件路径。
- 本扩展不添加遥测或云端上传，预览脚本、样式和解析器均随扩展提供。Vivado 及其许可服务、VS Code、配套扩展各有独立的网络行为；硬件编程会连接配置的 `hw_server`。
- 源码快照、报告和仿真波形可能包含专有设计数据及本机路径。请勿将 `.vivado/`、生成的波形、凭据或本地设置上传到公开仓库。异常终止可能在系统临时目录留下源码快照。
- 器件编程需要明确确认；示例引脚约束不构成开发板安全保证。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 找不到 Vivado | 选择版本目录，而不是可执行文件；确认四个命令行工具齐全。显式路径无效时不会自动回退到其他版本。 |
| 没有语法高亮 | 安装并启用必需依赖 `mshr-h.veriloghdl`，然后重载窗口；检查编辑器语言模式及自定义 `files.associations`。 |
| 编辑器没有工程操作 | 用 **Vivado: Open Project** 打开项目的 `vivado-project.json`，信任工作区并执行 **Vivado: Refresh Project**。已关闭项目不会显示运行入口。 |
| 无法输入 Tcl 命令 | 使用 **Vivado: Open Tcl Console**，不要在 Output 或仿真输出终端中输入。 |
| 重复诊断 | 将配套扩展的 `verilog.linting.linter` 设为 `none`。 |
| 中文输出乱码 | 设置 `vivado.outputEncoding` 为 `gbk` 后重新运行。 |
| 仿真不结束 | 设置有限的 `simulationRunTime`，或确保 `all` 模式的 testbench 调用 `$finish`；必要时取消操作。 |
| 原理图或 I/O 表格过期 | 保存源码后重新 **Synthesize**；编辑 I/O 前先重新加载。 |
| 工程被锁定或遭意外修改 | 从 VS Code 构建前关闭原生 Vivado GUI 工程。 |
| 找不到硬件目标 | 检查供电、线缆驱动、服务器地址和连接；构建成功并不能验证开发板。 |

提交问题时请附扩展、VS Code、操作系统和 Vivado 版本、最小复现工程及脱敏后的 **Output > Vivado** 日志。不要公开 token、专有 HDL、开发板序列号或未经脱敏的绝对路径。问题反馈见[仓库 Issues](https://github.com/La-Theresa/vivado-for-vscode/issues)。

## 当前限制

- 实际 FPGA 编程、Flash 编程和板级电气正确性仍需物理硬件验证。
- IP（`.xci`）和 Block Design（`.bd`）可列出并通过 GUI 打开，但本版本自动构建流程会拒绝它们。
- 未实现 VHDL、混合语言仿真、自定义编译库、UVM 或时序仿真。
- 内置波形限制为 8 MiB 输入、2048 个信号、每信号 4096 位、64 层层级、500000 次变化，以及 32 MiB 的展开时间线预算；时间戳必须在 JavaScript 精确整数范围内。同时显示最多 64 个匹配信号，可通过筛选查看其他信号。较大波形请使用 WDB 或外部 VCD 查看器。
- 内置原理图最多支持 1000 个 primitive 单元、2000 个端口、20000 个 pin 和 6000 条连接；较大电路请使用 GUI。预览不支持某些数据不会使已经成功的构建或仿真失效。
- 独立语法检查没有预编译的项目 package；大量使用 SystemVerilog package 时，可能需关闭输入时检查，改用工程展开检查。
- Windows 批处理参数中的双引号、百分号和换行会被显式拒绝，包括带引号的字符串宏。普通空格和中文路径另有测试。
- I/O 规划只检查封装引脚归属、重复占用和基本标准兼容性，不包括完整板级电气验证、testbench 生成、开发板模板或配置 Flash。
- 语法检查使用临时源码快照。正常完成会清理快照，扩展停用会取消工具；强制终止扩展宿主可能留下临时文件。

## 许可证

本项目源码采用 [MIT](LICENSE) 许可证；捆绑依赖保留各自许可证，构建时生成 `dist/THIRD_PARTY_NOTICES.md`。VCD 解析器由本项目 Rust 源码和锁定依赖自行构建，保留上游许可证正文，并附二进制与源码哈希记录，不再使用预编译的 `rust_vcd_wasm` 包。来源与声明覆盖范围见 [third_party/README.md](third_party/README.md)。本项目不附带 Vivado，也不重新授权 Vivado。

Vivado 和 Xilinx 是其所有者的商标。本项目是独立社区项目，不是 AMD 产品，也未与 AMD 建立隶属关系或获得其背书。
