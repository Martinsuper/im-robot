import type { OutfitState, OutfitItem, OutfitCategory } from "./outfitTypes";
import { outfitLoader } from "./OutfitLoader";

// 渲染图层顺序
const LAYER_ORDER: OutfitCategory[] = [
  "background",
  "effect",
  "accessory",
  "hat",
];

// 动画状态接口
interface AnimationState {
  frame: number;
  lastFrameTime: number;
  playing: boolean;
}

/**
 * 装扮渲染器
 * 负责将装扮渲染到精灵上，管理图层和动画效果
 */
export class OutfitRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animations: Map<string, AnimationState> = new Map();
  private animationFrameId: number | null = null;
  private _currentOutfit: OutfitState = {
    hat: null,
    accessory: null,
    background: null,
    effect: null,
  };

  /**
   * 获取当前装扮状态
   */
  get currentOutfit(): OutfitState {
    return this._currentOutfit;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /**
   * 渲染装扮到画布上
   * @param outfit 当前装扮状态
   */
  async renderOutfit(outfit: OutfitState): Promise<void> {
    this._currentOutfit = outfit;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 按图层顺序渲染
    for (const category of LAYER_ORDER) {
      const itemId = outfit[category];
      if (!itemId) continue;

      const item = this.getItemById(itemId);
      if (!item) continue;

      try {
        const asset = await outfitLoader.loadAsset(item);
        this.renderLayer(asset, item);
      } catch (error) {
        console.error(`Failed to render outfit layer: ${category}`, error);
      }
    }
  }

  /**
   * 渲染单个图层
   * @param image 装扮图像
   * @param item 装扮物品
   */
  private renderLayer(image: HTMLImageElement, item: OutfitItem): void {
    const { width, height } = this.canvas;

    // 根据装扮类别确定渲染位置和大小
    switch (item.category) {
      case "background":
        // 背景铺满整个画布
        this.ctx.drawImage(image, 0, 0, width, height);
        break;
      case "effect":
        // 效果层居中渲染，保持比例
        this.renderCentered(image, width, height, 0.8);
        break;
      case "accessory":
        // 饰品渲染在精灵右下角
        this.renderAtPosition(image, width * 0.7, height * 0.6, 0.3);
        break;
      case "hat":
        // 帽子渲染在精灵顶部
        this.renderAtPosition(image, width * 0.5, height * 0.1, 0.4);
        break;
    }
  }

  /**
   * 居中渲染图像
   * @param image 图像
   * @param canvasWidth 画布宽度
   * @param canvasHeight 画布高度
   * @param scale 缩放比例
   */
  private renderCentered(
    image: HTMLImageElement,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
  ): void {
    const imgWidth = image.width * scale;
    const imgHeight = image.height * scale;
    const x = (canvasWidth - imgWidth) / 2;
    const y = (canvasHeight - imgHeight) / 2;
    this.ctx.drawImage(image, x, y, imgWidth, imgHeight);
  }

  /**
   * 在指定位置渲染图像
   * @param image 图像
   * @param x X坐标
   * @param y Y坐标
   * @param scale 缩放比例
   */
  private renderAtPosition(
    image: HTMLImageElement,
    x: number,
    y: number,
    scale: number,
  ): void {
    const imgWidth = image.width * scale;
    const imgHeight = image.height * scale;
    this.ctx.drawImage(
      image,
      x - imgWidth / 2,
      y - imgHeight / 2,
      imgWidth,
      imgHeight,
    );
  }

  /**
   * 启动装扮动画
   * @param itemId 装扮物品ID
   */
  startAnimation(itemId: string): void {
    this.animations.set(itemId, {
      frame: 0,
      lastFrameTime: Date.now(),
      playing: true,
    });

    if (!this.animationFrameId) {
      this.animate();
    }
  }

  /**
   * 停止装扮动画
   * @param itemId 装扮物品ID
   */
  stopAnimation(itemId: string): void {
    this.animations.delete(itemId);

    if (this.animations.size === 0 && this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * 动画循环
   */
  private animate = (): void => {
    const now = Date.now();

    this.animations.forEach((state, itemId) => {
      if (!state.playing) return;

      const item = this.getItemById(itemId);
      if (!item || !item.animationFrames || !item.animationDuration) return;

      const frameDuration = item.animationDuration / item.animationFrames;
      if (now - state.lastFrameTime >= frameDuration) {
        state.frame = (state.frame + 1) % item.animationFrames;
        state.lastFrameTime = now;
      }
    });

    if (this.animations.size > 0) {
      this.animationFrameId = requestAnimationFrame(this.animate);
    }
  };

  /**
   * 根据ID查找装扮物品（简化实现）
   * @param itemId 装扮物品ID
   */
  private getItemById(_itemId: string): OutfitItem | null {
    // 实际实现中应该从OutfitManager获取
    return null;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.animations.clear();
  }

  /**
   * 更新画布尺寸
   * @param width 新宽度
   * @param height 新高度
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }
}

// 工厂函数
export function createOutfitRenderer(
  canvas: HTMLCanvasElement,
): OutfitRenderer {
  return new OutfitRenderer(canvas);
}
