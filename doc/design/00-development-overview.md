# Piko 开发总览

这是一份总索引，帮助快速定位到真正的主文档。

## 文档入口

| 分类 | 文档 |
| --- | --- |
| PRD | [人宠交互详细实现方案](../prd/00-pet-human-interaction-detailed-design.md) |
| PRD | [宠物身份与养成产品方案](../prd/01-pet-identity-nurturing-product.md) |
| PRD | [桌面助手产品基线与路线图](../prd/02-desktop-assistant-baseline-roadmap.md) |
| PRD | [桌面代理交付计划](../prd/03-desktop-agent-delivery-plan.md) |
| Design | [宠物核心系统设计](01-pet-core-systems.md) |
| Design | [角色驱动化视觉系统设计](05-piko-character-driven-visual-system.md) |
| Design | [角色驱动化视觉技术方案](06-piko-character-driven-visual-implementation.md) |
| Design | [应用壳层与桌面代理设计](02-app-shell-agent-operations.md) |
| Design | [记忆、存储与数据设计](03-memory-storage-and-data.md) |
| Design | [插件、素材与质量设计](04-plugins-tooling-quality.md) |

## 当前技术骨架

- 前端：React + TypeScript
- 桌面壳：Tauri 2
- 宠物渲染：sprite / canvas 体系
- 状态与数据：前端状态 + Rust 持久化服务

## 文档原则

- 产品文档只回答“为什么做、做什么、做到什么程度”。
- 设计文档只回答“怎么实现、怎么分层、怎么验证”。
- 细碎文档尽量并入主文档，避免同一主题出现多份平行版本。

#### 5.3.1 单元测试

```typescript
// petState.test.ts
describe("petState", () => {
  it("should handle WAKE event", () => {
    const state = reducePetState(initialPetState, { type: "WAKE" });
    expect(state.mode).toBe("idle");
    expect(state.emotion).toBe("happy");
  });
});
```

#### 5.3.2 测试覆盖率

| 模块 | 目标覆盖率 |
|------|-----------|
| petState.ts | ≥90% |
| growth/*.ts | ≥80% |
| personality/*.ts | ≥80% |
| outfit/*.ts | ≥80% |

---

## 六、风险评估

### 6.1 技术风险

| 风险 | 影响 | 概率 | 应对措施 |
|------|------|------|---------|
| PixiJS性能问题 | 动画卡顿 | 中 | 预留优化时间，使用对象池 |
| 跨平台兼容性 | 功能异常 | 中 | 多平台测试，使用polyfill |
| 内存泄漏 | 应用崩溃 | 低 | 严格内存管理，定期检测 |

### 6.2 进度风险

| 风险 | 影响 | 概率 | 应对措施 |
|------|------|------|---------|
| 设计资源不足 | 延期 | 中 | 提前规划，预留缓冲 |
| 需求变更 | 延期 | 中 | 需求冻结，变更控制 |
| 技术难点 | 延期 | 低 | 技术预研，方案评审 |

### 6.3 质量风险

| 风险 | 影响 | 概率 | 应对措施 |
|------|------|------|---------|
| 用户体验差 | 使用率低 | 中 | 用户调研，快速迭代 |
| 性能不达标 | 体验差 | 低 | 持续优化，监控指标 |
| 功能缺陷 | 口碑差 | 低 | 充分测试，代码评审 |

---

## 七、资源需求

### 7.1 人力资源

| 角色 | 人数 | 职责 |
|------|------|------|
| 全栈开发 | 1 | 核心功能开发 |
| UI设计 | 0.5 | 精灵设计、UI设计 |
| 测试 | 0.5 | 功能测试、性能测试 |

### 7.2 设备资源

| 设备 | 用途 |
|------|------|
| macOS开发机 | 主开发环境 |
| Windows测试机 | 跨平台测试 |
| Linux测试机 | 跨平台测试 |

### 7.3 工具资源

| 工具 | 用途 | 成本 |
|------|------|------|
| Aseprite | 像素设计 | $20 |
| Figma | UI设计 | 免费版 |
| GitHub | 代码托管 | 免费版 |

---

## 八、交付物清单

### 8.1 代码交付

| 交付物 | 说明 |
|--------|------|
| 源代码 | 完整的项目代码 |
| 单元测试 | 测试用例和测试报告 |
| E2E测试 | 自动化测试脚本 |
| 构建脚本 | CI/CD配置 |

### 8.2 文档交付

| 交付物 | 说明 |
|--------|------|
| 技术文档 | 架构设计、接口文档 |
| 用户文档 | 使用手册、FAQ |
| 开发文档 | 开发指南、贡献指南 |

### 8.3 设计交付

| 交付物 | 说明 |
|--------|------|
| 精灵素材 | sprite sheet、图标 |
| UI设计稿 | Figma设计文件 |
| 动画设计 | 动画规范和示例 |

---

## 九、变更记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-06-05 | v1.0 | 初始版本，开发计划总览 |
