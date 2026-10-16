import { CSSProperties } from "react";
import { getRobotCatFrame,petSpriteStates,useCustomPetImageUrl,usePetVisualStyle } from "./appSharedData";


export function PetSprite({
  mode = "idle",
  emotion = "neutral",
  reaction = "none",
  compact = false,
  mouseDelta,
}: {
  mode?: keyof typeof petSpriteStates;
  emotion?: string;
  reaction?: string;
  compact?: boolean;
  mouseDelta?: { x: number; y: number };
}) {
  const sprite = petSpriteStates[mode];
  const visualStyle = usePetVisualStyle();
  const customPetImageUrl = useCustomPetImageUrl();
  const effectiveVisualStyle = visualStyle === "custom" && !customPetImageUrl ? "classic" : visualStyle;
  const robotCatFrame = getRobotCatFrame(mode, emotion, reaction);
  const style = {
    "--sprite-row": sprite.row,
    "--sprite-frames": sprite.frames,
    "--sprite-duration": `${sprite.duration}ms`,
    "--robot-cat-col": robotCatFrame % 4,
    "--robot-cat-row": Math.floor(robotCatFrame / 4),
    "--look-x": mouseDelta ? `${mouseDelta.x * 6}px` : "0px",
    "--look-y": mouseDelta ? `${mouseDelta.y * 4}px` : "0px",
    "--eye-x": mouseDelta ? `${mouseDelta.x * 5}px` : "0px",
    "--eye-y": mouseDelta ? `${mouseDelta.y * 4}px` : "0px",
    "--pet-tilt": mouseDelta ? `${mouseDelta.x * 3}deg` : "0deg",
    "--custom-pet-image": customPetImageUrl ? `url("${customPetImageUrl}")` : "none",
  } as CSSProperties;

  if (effectiveVisualStyle === "classic") {
    return (
      <span className={`pet-sprite-frame pet-sprite-frame--classic${compact ? " pet-sprite-frame--compact" : ""}`}>
        <span className="pet-sprite" style={style} />
      </span>
    );
  }

  if (effectiveVisualStyle === "lumi") {
    return (
      <span
        className={`pet-sprite-frame pet-sprite-frame--robot-cat${compact ? " pet-sprite-frame--compact" : ""}`}
        style={style}
      >
        <span
          className={`robot-cat-sprite robot-cat-sprite--${mode} robot-cat-sprite--emotion-${emotion} robot-cat-sprite--reaction-${reaction}`}
          aria-hidden="true"
        >
          <span className="robot-cat-glow" />
          <span className="robot-cat-image" />
          <span className="robot-cat-shadow" />
        </span>
      </span>
    );
  }

  if (effectiveVisualStyle === "custom" && customPetImageUrl) {
    return (
      <span
        className={`pet-sprite-frame pet-sprite-frame--custom${compact ? " pet-sprite-frame--compact" : ""}`}
        style={style}
      >
        <span
          className={`custom-pet-sprite custom-pet-sprite--${mode} custom-pet-sprite--emotion-${emotion} custom-pet-sprite--reaction-${reaction}`}
          aria-hidden="true"
        >
          <span className="custom-pet-glow" />
          <span className="custom-pet-image" />
          <span className="custom-pet-shadow" />
        </span>
      </span>
    );
  }

  return (
    <span className={`pet-sprite-frame pet-sprite-frame--classic${compact ? " pet-sprite-frame--compact" : ""}`}>
      <span className="pet-sprite" style={style} />
    </span>
  );
}
