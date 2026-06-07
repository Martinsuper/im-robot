
# Piko 精灵图占位符

这个文件夹需要包含以下文件：

## 文件列表

1. `piko-egg.png` - 精灵图集（1536×1872 像素）
2. `piko-egg.json` - 元数据文件（已创建）

## 如何生成精灵图

### 方法 1：使用 Piskel

1. 访问 https://www.piskelapp.com/
2. 创建新项目，设置画布尺寸：192×208
3. 绘制动画帧（至少 72 帧）
4. 导出为 PNG Sprite Sheet：
   - 列数：8
   - 行数：9
   - 导出文件名：piko-egg.png

### 方法 2：使用 LibreSprite

```bash
# 安装 LibreSprite
brew install --cask libresprite

# 创建精灵图
# 1. 打开 LibreSprite
# 2. 新建文件：192×208 像素
# 3. 绘制动画并添加标签
# 4. 导出为 Sprite Sheet
```

### 方法 3：命令行导出

```bash
libresprite -b piko-egg.ase \
  --sheet piko-egg.png \
  --sheet-type rows \
  --sheet-columns 8 \
  --data piko-egg.json \
  --list-tags
```

## 精灵图规格

| 属性 | 值 |
|------|-----|
| 画布尺寸 | 192×208 |
| 精灵尺寸 | 156×156（蛋壳期） |
| 总尺寸 | 1536×1872（8列×9行） |
| 格式 | PNG（RGBA） |
| 背景 | 透明 |

## 动画帧分布

- Row 0: idle (8帧)
- Row 1: walk (6帧)
- Row 2: blink (4帧)
- Row 3: happy (6帧)
- Row 4: curious (6帧)
- Row 5: sleepy (6帧)
- Row 6: surprised (6帧)
- Row 7: worried (6帧)
- Row 8: excited (6帧) + thoughtful (6帧) + playful (6帧)

## 测试占位符

如果没有真实精灵图，可以使用以下方法创建测试占位符：

```javascript
// 使用 Node.js + canvas 模块生成占位符
npm install canvas

// 创建简单的占位符精灵图
```

## 注意事项

- 确保所有帧的尺寸一致（192×208）
- 精灵在画布内居中绘制
- 使用透明背景
- JSON 元数据文件已准备好，无需手动修改
