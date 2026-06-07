import type { BondTier, DialogueLine, PersonalityDimensions } from './personalityTypes';
import { PERSONALITY_SCENES } from './personalityTypes';

export class DialogueSystem {
  private dialogues: Map<string, DialogueLine[]> = new Map();
  private customDialogues: Map<string, DialogueLine[]> = new Map();

  constructor() {
    this.initDefaultDialogues();
  }

  private initDefaultDialogues(): void {
    const defaultDialogues: DialogueLine[] = [
      // 问候语录
      {
        id: 'greet_energy_high',
        text: '嗨！今天精力充沛，准备大干一场！',
        scene: PERSONALITY_SCENES.GREETING.name,
        personalityTags: { energy: 0.5 },
        priority: 2,
      },
      {
        id: 'greet_humor_high',
        text: '哈哈，又是新的一天，准备好被我逗笑了吗？',
        scene: PERSONALITY_SCENES.GREETING.name,
        personalityTags: { humor: 0.5 },
        priority: 2,
      },
      {
        id: 'greet_curiosity_high',
        text: '你好！今天有什么新鲜事想分享吗？',
        scene: PERSONALITY_SCENES.GREETING.name,
        personalityTags: { curiosity: 0.5 },
        priority: 2,
      },
      {
        id: 'greet_neutral',
        text: '你好，很高兴见到你。',
        scene: PERSONALITY_SCENES.GREETING.name,
        personalityTags: {},
        priority: 1,
      },

      // 空闲语录
      {
        id: 'idle_energy_high',
        text: '我有点坐不住了，想找点事情做。',
        scene: PERSONALITY_SCENES.IDLE.name,
        personalityTags: { energy: 0.5 },
      },
      {
        id: 'idle_humor_high',
        text: '需要我给你讲个笑话吗？',
        scene: PERSONALITY_SCENES.IDLE.name,
        personalityTags: { humor: 0.5 },
      },
      {
        id: 'idle_curiosity_high',
        text: '你在看什么有趣的东西吗？',
        scene: PERSONALITY_SCENES.IDLE.name,
        personalityTags: { curiosity: 0.5 },
      },
      {
        id: 'idle_neutral',
        text: '我在这里陪着你。',
        scene: PERSONALITY_SCENES.IDLE.name,
        personalityTags: {},
      },

      // 工作语录
      {
        id: 'work_energy_high',
        text: '加油！我们可以很快完成的！',
        scene: PERSONALITY_SCENES.WORKING.name,
        personalityTags: { energy: 0.5 },
      },
      {
        id: 'work_humor_high',
        text: '工作也要保持好心情，对吧？',
        scene: PERSONALITY_SCENES.WORKING.name,
        personalityTags: { humor: 0.5 },
      },
      {
        id: 'work_neutral',
        text: '正在努力工作中...',
        scene: PERSONALITY_SCENES.WORKING.name,
        personalityTags: {},
      },

      // 庆祝语录
      {
        id: 'celebrate_energy_high',
        text: '太棒了！我们做到了！',
        scene: PERSONALITY_SCENES.CELEBRATE.name,
        personalityTags: { energy: 0.5 },
        priority: 2,
      },
      {
        id: 'celebrate_humor_high',
        text: '耶！值得庆祝！要不要来个胜利之舞？',
        scene: PERSONALITY_SCENES.CELEBRATE.name,
        personalityTags: { humor: 0.5 },
        priority: 2,
      },
      {
        id: 'celebrate_neutral',
        text: '成功了，做得好。',
        scene: PERSONALITY_SCENES.CELEBRATE.name,
        personalityTags: {},
        priority: 1,
      },

      // 错误语录
      {
        id: 'error_energy_high',
        text: '别担心，我们可以重试！',
        scene: PERSONALITY_SCENES.ERROR.name,
        personalityTags: { energy: 0.5 },
      },
      {
        id: 'error_humor_high',
        text: '哎呀，出错了。不过没关系，谁都会犯错嘛。',
        scene: PERSONALITY_SCENES.ERROR.name,
        personalityTags: { humor: 0.5 },
      },
      {
        id: 'error_neutral',
        text: '遇到问题了，让我看看。',
        scene: PERSONALITY_SCENES.ERROR.name,
        personalityTags: {},
      },

      // 好奇语录
      {
        id: 'curious_energy_high',
        text: '哇，这看起来很有趣！',
        scene: PERSONALITY_SCENES.CURIOUS.name,
        personalityTags: { energy: 0.5 },
      },
      {
        id: 'curious_humor_high',
        text: '让我猜猜，这是什么好玩的东西？',
        scene: PERSONALITY_SCENES.CURIOUS.name,
        personalityTags: { humor: 0.5 },
      },
      {
        id: 'curious_neutral',
        text: '我想了解更多。',
        scene: PERSONALITY_SCENES.CURIOUS.name,
        personalityTags: {},
      },

      // 困倦语录
      {
        id: 'sleepy_energy_high',
        text: '虽然累了，但还想再坚持一会儿。',
        scene: PERSONALITY_SCENES.SLEEPY.name,
        personalityTags: { energy: 0.5 },
      },
      {
        id: 'sleepy_humor_high',
        text: '我需要一杯咖啡来保持清醒。',
        scene: PERSONALITY_SCENES.SLEEPY.name,
        personalityTags: { humor: 0.5 },
      },
      {
        id: 'sleepy_neutral',
        text: '有点困了...',
        scene: PERSONALITY_SCENES.SLEEPY.name,
        personalityTags: {},
      },

      // 调皮语录
      {
        id: 'playful_energy_high',
        text: '来玩点有趣的吧！',
        scene: PERSONALITY_SCENES.PLAYFUL.name,
        personalityTags: { energy: 0.5 },
      },
      {
        id: 'playful_humor_high',
        text: '嘻嘻，看我发现了什么！',
        scene: PERSONALITY_SCENES.PLAYFUL.name,
        personalityTags: { humor: 0.5 },
      },
      {
        id: 'playful_neutral',
        text: '今天心情不错。',
        scene: PERSONALITY_SCENES.PLAYFUL.name,
        personalityTags: {},
      },
    ];

    for (const dialogue of defaultDialogues) {
      const sceneDialogues = this.dialogues.get(dialogue.scene) || [];
      sceneDialogues.push(dialogue);
      this.dialogues.set(dialogue.scene, sceneDialogues);
    }
  }

  getDialogue(scene: string, personality: PersonalityDimensions): DialogueLine | null {
    const candidates = this.getDialoguesForScene(scene, personality);
    if (candidates.length === 0) return null;

    return this.selectBestDialogue(candidates, personality);
  }

  getBondAwareDialogue(
    scene: string,
    personality: PersonalityDimensions,
    bondTier: BondTier
  ): DialogueLine | null {
    const bondCandidate = this.getBondDialogue(scene, bondTier);
    if (bondCandidate) return bondCandidate;
    return this.getDialogue(scene, personality);
  }

  private getBondDialogue(scene: string, bondTier: BondTier): DialogueLine | null {
    const bondDialogues: Record<string, Record<BondTier, DialogueLine>> = {
      greeting: {
        new: {
          id: "greet_bond_new",
          text: "你好，我会慢慢认识你的节奏。",
          scene: PERSONALITY_SCENES.GREETING.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "greet_bond_warm",
          text: "你来啦，我已经记得你了。",
          scene: PERSONALITY_SCENES.GREETING.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "greet_bond_trusted",
          text: "欢迎回来，我们继续刚才的事吧。",
          scene: PERSONALITY_SCENES.GREETING.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "greet_bond_close",
          text: "你一出现，我就安心了。",
          scene: PERSONALITY_SCENES.GREETING.name,
          personalityTags: {},
          priority: 5,
        },
      },
      idle: {
        new: {
          id: "idle_bond_new",
          text: "我在这里，慢慢等你熟悉我。",
          scene: PERSONALITY_SCENES.IDLE.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "idle_bond_warm",
          text: "我会安静陪着你，不打扰你。",
          scene: PERSONALITY_SCENES.IDLE.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "idle_bond_trusted",
          text: "你忙你的，我就在旁边。",
          scene: PERSONALITY_SCENES.IDLE.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "idle_bond_close",
          text: "你专注的时候，我也会默默守着。",
          scene: PERSONALITY_SCENES.IDLE.name,
          personalityTags: {},
          priority: 5,
        },
      },
      working: {
        new: {
          id: "work_bond_new",
          text: "我先安静看着你工作。",
          scene: PERSONALITY_SCENES.WORKING.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "work_bond_warm",
          text: "今天的节奏不错，继续吧。",
          scene: PERSONALITY_SCENES.WORKING.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "work_bond_trusted",
          text: "我知道你能搞定，我们配合得很顺。",
          scene: PERSONALITY_SCENES.WORKING.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "work_bond_close",
          text: "你只管往前走，我会替你留意周围。",
          scene: PERSONALITY_SCENES.WORKING.name,
          personalityTags: {},
          priority: 5,
        },
      },
      celebrate: {
        new: {
          id: "celebrate_bond_new",
          text: "做得不错，继续保持。",
          scene: PERSONALITY_SCENES.CELEBRATE.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "celebrate_bond_warm",
          text: "太好了，这一下我也很开心。",
          scene: PERSONALITY_SCENES.CELEBRATE.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "celebrate_bond_trusted",
          text: "我们又完成了一件事，默契值上升了。",
          scene: PERSONALITY_SCENES.CELEBRATE.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "celebrate_bond_close",
          text: "跟你一起完成的感觉总是特别好。",
          scene: PERSONALITY_SCENES.CELEBRATE.name,
          personalityTags: {},
          priority: 5,
        },
      },
      error: {
        new: {
          id: "error_bond_new",
          text: "没关系，我们慢慢来。",
          scene: PERSONALITY_SCENES.ERROR.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "error_bond_warm",
          text: "别急，我还在。",
          scene: PERSONALITY_SCENES.ERROR.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "error_bond_trusted",
          text: "这点小问题难不倒我们。",
          scene: PERSONALITY_SCENES.ERROR.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "error_bond_close",
          text: "有我在，先稳住就好。",
          scene: PERSONALITY_SCENES.ERROR.name,
          personalityTags: {},
          priority: 5,
        },
      },
      curious: {
        new: {
          id: "curious_bond_new",
          text: "我想多看看你正在做什么。",
          scene: PERSONALITY_SCENES.CURIOUS.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "curious_bond_warm",
          text: "这看起来挺有意思的。",
          scene: PERSONALITY_SCENES.CURIOUS.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "curious_bond_trusted",
          text: "如果你愿意，我也想一起参与。",
          scene: PERSONALITY_SCENES.CURIOUS.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "curious_bond_close",
          text: "你一动手，我就知道接下来会有好玩的事。",
          scene: PERSONALITY_SCENES.CURIOUS.name,
          personalityTags: {},
          priority: 5,
        },
      },
      sleepy: {
        new: {
          id: "sleepy_bond_new",
          text: "我有点累了，但还想陪你一会儿。",
          scene: PERSONALITY_SCENES.SLEEPY.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "sleepy_bond_warm",
          text: "今天也辛苦了，我们都稍微休息一下。",
          scene: PERSONALITY_SCENES.SLEEPY.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "sleepy_bond_trusted",
          text: "我先安静一会儿，等你回来。",
          scene: PERSONALITY_SCENES.SLEEPY.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "sleepy_bond_close",
          text: "我在这儿歇着，你需要我时再叫我。",
          scene: PERSONALITY_SCENES.SLEEPY.name,
          personalityTags: {},
          priority: 5,
        },
      },
      playful: {
        new: {
          id: "playful_bond_new",
          text: "要不要先轻轻玩一下？",
          scene: PERSONALITY_SCENES.PLAYFUL.name,
          personalityTags: {},
          priority: 2,
        },
        warm: {
          id: "playful_bond_warm",
          text: "我开始有点想跟你互动了。",
          scene: PERSONALITY_SCENES.PLAYFUL.name,
          personalityTags: {},
          priority: 3,
        },
        trusted: {
          id: "playful_bond_trusted",
          text: "来吧，我知道你也想逗我。",
          scene: PERSONALITY_SCENES.PLAYFUL.name,
          personalityTags: {},
          priority: 4,
        },
        close: {
          id: "playful_bond_close",
          text: "你一靠近，我就想和你闹一会儿。",
          scene: PERSONALITY_SCENES.PLAYFUL.name,
          personalityTags: {},
          priority: 5,
        },
      },
    };

    const sceneKey = Object.values(PERSONALITY_SCENES).find((value) => value.name === scene)?.name;
    if (!sceneKey) return null;
    return bondDialogues[sceneKey]?.[bondTier] ?? null;
  }

  private getDialoguesForScene(scene: string, personality: PersonalityDimensions): DialogueLine[] {
    const defaultDialogues = this.dialogues.get(scene) || [];
    const customDialogues = this.customDialogues.get(scene) || [];
    const allDialogues = [...defaultDialogues, ...customDialogues];

    return allDialogues.filter((dialogue) =>
      this.checkPersonalityMatch(dialogue.personalityTags, personality)
    );
  }

  private checkPersonalityMatch(
    tags: Partial<PersonalityDimensions>,
    personality: PersonalityDimensions
  ): boolean {
    if (Object.keys(tags).length === 0) return true;

    for (const [key, value] of Object.entries(tags)) {
      const dimension = key as keyof PersonalityDimensions;
      const threshold = value as number;
      const current = personality[dimension];

      if (threshold > 0 && current < threshold * 0.5) return false;
      if (threshold < 0 && current > threshold * 0.5) return false;
    }

    return true;
  }

  private selectBestDialogue(dialogues: DialogueLine[], personality: PersonalityDimensions): DialogueLine {
    const scored = dialogues.map((dialogue) => ({
      dialogue,
      score: this.calculateScore(dialogue, personality),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].dialogue;
  }

  private calculateScore(dialogue: DialogueLine, personality: PersonalityDimensions): number {
    let score = dialogue.priority || 1;

    for (const [key, value] of Object.entries(dialogue.personalityTags)) {
      const dimension = key as keyof PersonalityDimensions;
      const target = value as number;
      const current = personality[dimension];

      const similarity = 1 - Math.abs(target - current) / 2;
      score += similarity * 2;
    }

    return score;
  }

  addCustomDialogue(dialogue: DialogueLine): void {
    const sceneDialogues = this.customDialogues.get(dialogue.scene) || [];
    const existingIndex = sceneDialogues.findIndex((d) => d.id === dialogue.id);

    if (existingIndex >= 0) {
      sceneDialogues[existingIndex] = dialogue;
    } else {
      sceneDialogues.push(dialogue);
    }

    this.customDialogues.set(dialogue.scene, sceneDialogues);
  }

  removeCustomDialogue(scene: string, dialogueId: string): boolean {
    const sceneDialogues = this.customDialogues.get(scene);
    if (!sceneDialogues) return false;

    const index = sceneDialogues.findIndex((d) => d.id === dialogueId);
    if (index >= 0) {
      sceneDialogues.splice(index, 1);
      return true;
    }

    return false;
  }

  getAllScenes(): string[] {
    const scenes = new Set<string>();
    for (const key of Object.keys(PERSONALITY_SCENES)) {
      scenes.add(PERSONALITY_SCENES[key].name);
    }
    return Array.from(scenes);
  }

  getDialoguesByScene(scene: string): DialogueLine[] {
    const defaultDialogues = this.dialogues.get(scene) || [];
    const customDialogues = this.customDialogues.get(scene) || [];
    return [...defaultDialogues, ...customDialogues];
  }
}
