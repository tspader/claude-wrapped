import {
  BoxRenderable,
  TextRenderable,
  RGBA,
  t,
  fg,
  dim,
  bold,
  italic,
  brightCyan,
  StyledText,
  type TextChunk,
} from "@opentui/core";
import { SLIDES, START_SLIDE, type Slide } from "./slides";
import { CLAUDE_LOGO, WRAPPED_LOGO, LOGO_WIDTH, CLAUDE_COLOR, WRAPPED_COLOR } from "./logo";

// Off-white cursor color
const cursorStyle = fg("#CCCCCC");

// Extract plain text from StyledText chunks
function getPlainText(styled: StyledText): string {
  return styled.chunks.map(c => c.text).join("");
}

// Slice StyledText to show only first N visible characters
function sliceStyledText(styled: StyledText, maxChars: number): StyledText {
  const chunks: TextChunk[] = [];
  let remaining = maxChars;

  for (const chunk of styled.chunks) {
    if (remaining <= 0) break;

    if (chunk.text.length <= remaining) {
      chunks.push(chunk);
      remaining -= chunk.text.length;
    } else {
      chunks.push({
        ...chunk,
        text: chunk.text.slice(0, remaining),
      });
      remaining = 0;
    }
  }

  return new StyledText(chunks);
}

// Concatenate StyledText objects
function concatStyledText(...parts: (StyledText | TextChunk)[]): StyledText {
  const chunks: TextChunk[] = [];
  for (const part of parts) {
    if (part instanceof StyledText) {
      chunks.push(...part.chunks);
    } else {
      chunks.push(part);
    }
  }
  return new StyledText(chunks);
}

// Create a plain text chunk
function plainChunk(text: string): TextChunk {
  return { __isChunk: true, text, attributes: 0 } as TextChunk;
}

export class StatsBox {
  container: BoxRenderable;
  titleText: TextRenderable;
  contentText: TextRenderable;
  logoContainer!: BoxRenderable;
  private normalContent!: BoxRenderable;
  private titleContainer!: BoxRenderable;
  private optionsContainer!: BoxRenderable;
  private renderer: any;

  // Layout
  private useLogo: boolean = false;

  // State
  private statsData: any = {};
  private currentSlideId: string = START_SLIDE;

  // Typing State
  private fullStyled: StyledText = new StyledText([]);
  private plainText: string = "";
  private displayIndex: number = 0;
  private typeTimer: number = 0;
  private nextCharDelay: number = 0;
  private cursorBlinkTimer: number = 0;
  private showCursor: boolean = true;
  private typingFinished: boolean = false;

  // Prompt State
  private selectedOptionIndex: number = 0;

  constructor(renderer: any, width: number, height: number, left: number, top: number) {
    this.renderer = renderer;
    // Check if we have room for ASCII art logo (border=1, padding=1 on each side = 4 total)
    this.useLogo = (width - 4) >= LOGO_WIDTH;

    this.container = new BoxRenderable(renderer, {
      id: "stats-box",
      width,
      height,
      position: "absolute",
      left,
      top,
      border: true,
      borderStyle: "single",
      borderColor: "#FFFFFF",
      backgroundColor: RGBA.fromValues(0, 0, 0, 0.0),
      padding: 1,
      flexDirection: "column",
    });

    // logo - flexGrow fills available space, centering handled by justify/align
    this.logoContainer = new BoxRenderable(renderer, {
      id: "logo-container",
      flexGrow: 1,
      justifyContent: "center",
      alignItems: "center",
      flexDirection: "column",
      visible: true,
    });

    // Build logo as separate TextRenderables with margin instead of newlines
    const { claudeLogo, wrappedLogo } = this.buildLogoParts();

    this.logoContainer.add(new TextRenderable(renderer, {
      id: "logo-claude",
      content: claudeLogo,
      fg: "#FFFFFF",
      marginBottom: 1,
    }));

    this.logoContainer.add(new TextRenderable(renderer, {
      id: "logo-wrapped",
      content: wrappedLogo,
      fg: "#FFFFFF",
      marginBottom: 2,
    }));

    this.logoContainer.add(new TextRenderable(renderer, {
      id: "logo-prompt",
      content: t`${italic("press ")}${brightCyan("space")}${italic(" to continue")}`,
      fg: "#AAAAAA",
    }));


    // content
    this.normalContent = new BoxRenderable(renderer, {
      id: "normal-content",
      flexDirection: "column",
      visible: false,
    });

    // title - stretches to full width in column flex, justify centers content
    this.titleContainer = new BoxRenderable(renderer, {
      id: "title-container",
      justifyContent: "center",
      flexDirection: "row",
      marginBottom: 1,
    });

    this.titleText = new TextRenderable(renderer, {
      id: "title-text",
      content: this.buildTitle(),
      fg: "#FFFFFF",
    });

    this.titleContainer.add(this.titleText);

    this.contentText = new TextRenderable(renderer, {
      id: "content-text",
      content: "",
      fg: "#AAAAAA",
    });

    // options container (will be populated dynamically)
    this.optionsContainer = new BoxRenderable(renderer, {
      id: "options-container",
      flexDirection: "row",
      marginTop: 2,
      visible: false,
    });

    this.normalContent.add(this.titleContainer);
    this.normalContent.add(this.contentText);
    this.normalContent.add(this.optionsContainer);

    this.container.add(this.logoContainer);
    this.container.add(this.normalContent);

    this.goToSlide(START_SLIDE);
  }

  private buildLogoParts(): { claudeLogo: StyledText; wrappedLogo: StyledText } {
    const claudeStyle = fg(CLAUDE_COLOR);
    const wrappedStyle = fg(WRAPPED_COLOR);

    if (this.useLogo) {
      // Build CLAUDE logo
      const claudeParts: TextChunk[] = [];
      for (let i = 0; i < CLAUDE_LOGO.length; i++) {
        const line = CLAUDE_LOGO[i]!;
        if (i > 0) claudeParts.push(plainChunk("\n"));
        claudeParts.push(claudeStyle(line));
      }

      // Build WRAPPED logo
      const wrappedParts: TextChunk[] = [];
      for (let i = 0; i < WRAPPED_LOGO.length; i++) {
        const line = WRAPPED_LOGO[i]!;
        if (i > 0) wrappedParts.push(plainChunk("\n"));
        wrappedParts.push(wrappedStyle(line));
      }

      return {
        claudeLogo: concatStyledText(...claudeParts),
        wrappedLogo: concatStyledText(...wrappedParts),
      };
    } else {
      // Fallback: simple text
      return {
        claudeLogo: t`${claudeStyle("CLAUDE")}`,
        wrappedLogo: t`${wrappedStyle("WRAPPED")}`,
      };
    }
  }

  private buildTitle(): StyledText {
    const claudeStyle = fg(CLAUDE_COLOR);
    // Bold text - CLAUDE orange, WRAPPED white (centered via flexbox)
    return t`${bold(claudeStyle("CLAUDE"))} ${bold("WRAPPED")}`;
  }

  private getCurrentSlide(): Slide | undefined {
    return SLIDES[this.currentSlideId];
  }

  public setStatsData(data: any) {
    this.statsData = { ...this.statsData, ...data };
  }

  public getStatsData(): any {
    return this.statsData;
  }

  public setError(msg: string) {
    this.fullStyled = t`Error: ${msg}`;
    this.plainText = "Error: " + msg;
    this.displayIndex = this.plainText.length;
    this.typingFinished = true;
    this.renderContent();
  }

  private goToSlide(id: string) {
    const slide = SLIDES[id];
    if (!slide) return;

    this.currentSlideId = id;

    // Switch between logo slide (centered) and normal slides via visibility
    if (id === "logo") {
      this.logoContainer.visible = true;
      this.normalContent.visible = false;
    } else {
      this.logoContainer.visible = false;
      this.normalContent.visible = true;
    }

    this.fullStyled = slide.getText(this.statsData);
    this.plainText = getPlainText(this.fullStyled);

    if (slide.noTyping) {
      this.displayIndex = this.plainText.length;
      this.typingFinished = true;
    } else {
      this.displayIndex = 0;
      this.typingFinished = false;
      this.typeTimer = 0;
      this.nextCharDelay = 50;
    }

    this.selectedOptionIndex = 0;
    this.buildOptions(slide);
    this.renderContent();

    if (slide.type === "action" && slide.onEnter) {
      slide.onEnter(this);
    }
  }

  private buildOptions(slide: Slide) {
    // Clear existing options
    const children = this.optionsContainer.getChildren();
    for (const child of children) {
      this.optionsContainer.remove(child.id);
    }

    if (slide.type !== "prompt" || !slide.options) {
      this.optionsContainer.visible = false;
      return;
    }

    // Create option renderables
    slide.options.forEach((opt, i) => {
      const optionBox = new BoxRenderable(this.renderer, {
        id: `option-${i}`,
        flexDirection: "row",
        marginRight: 3,
      });

      const markerText = new TextRenderable(this.renderer, {
        id: `option-marker-${i}`,
        content: "  ",
        fg: "#FFFFFF",
      });

      const labelText = new TextRenderable(this.renderer, {
        id: `option-label-${i}`,
        content: opt.label,
        fg: "#AAAAAA",
      });

      optionBox.add(markerText);
      optionBox.add(labelText);
      this.optionsContainer.add(optionBox);
    });

    // Will be shown when typing finishes
    this.optionsContainer.visible = false;
  }

  private updateOptionsDisplay() {
    const slide = this.getCurrentSlide();
    if (!slide || slide.type !== "prompt" || !slide.options) return;

    const children = this.optionsContainer.getChildren();
    slide.options.forEach((opt, i) => {
      const optionBox = children[i];
      if (!optionBox) return;

      const boxChildren = optionBox.getChildren();
      const markerText = boxChildren[0] as TextRenderable;
      const labelText = boxChildren[1] as TextRenderable;

      const isSelected = i === this.selectedOptionIndex;
      markerText.content = isSelected ? "> " : "  ";

      if (isSelected) {
        labelText.content = t`${opt.style(`[ ${opt.label} ]`)}`;
      } else {
        labelText.content = t`${dim(opt.label)}`;
      }
    });
  }

  public nextSlide() {
    const slide = this.getCurrentSlide();
    if (slide) {
      this.goToSlide(slide.next);
    }
  }

  public update(deltaTime: number) {
    const slide = this.getCurrentSlide();
    if (!slide) return;

    // Cursor blink
    this.cursorBlinkTimer += deltaTime;
    if (this.cursorBlinkTimer > 500) {
      this.cursorBlinkTimer = 0;
      this.showCursor = !this.showCursor;
      this.renderContent();
    }

    // Typing
    if (!this.typingFinished) {
      this.typeTimer += deltaTime;
      if (this.typeTimer >= this.nextCharDelay) {
        this.typeTimer = 0;
        this.displayIndex++;

        // Base delay with jitter: 30-60ms
        this.nextCharDelay = 30 + Math.random() * 30;

        // Pause on punctuation
        if (this.displayIndex > 0 && this.displayIndex <= this.plainText.length) {
          const lastChar = this.plainText[this.displayIndex - 1];
          if (lastChar === '.' || lastChar === '?' || lastChar === '!') {
            this.nextCharDelay += 300;
          } else if (lastChar === ',') {
            this.nextCharDelay += 100;
          } else if (lastChar === '\n') {
            this.nextCharDelay += 200;
          }
        }

        if (this.displayIndex >= this.plainText.length) {
          this.displayIndex = this.plainText.length;
          this.typingFinished = true;
          // Show options when typing finishes
          const currentSlide = this.getCurrentSlide();
          if (currentSlide?.type === "prompt" && currentSlide.options) {
            this.optionsContainer.visible = true;
            this.updateOptionsDisplay();
          }
        }
        this.renderContent();
      }
    }
  }

  private renderContent() {
    const slide = this.getCurrentSlide();
    if (!slide) return;

    // Slice styled text to visible characters
    let content = sliceStyledText(this.fullStyled, this.displayIndex);

    // Blinking cursor (hide on prompt slides after typing finishes)
    const hidePromptCursor = slide.type === "prompt" && this.typingFinished;
    if (this.showCursor && !hidePromptCursor) {
      content = concatStyledText(content, cursorStyle("█"));
    }

    this.contentText.content = content;

    // Update options display if visible
    if (this.optionsContainer.visible) {
      this.updateOptionsDisplay();
    }
  }

  public async handleInput(key: string): Promise<void> {
    const slide = this.getCurrentSlide();
    if (!slide) return;

    // Fast forward typing
    if (!this.typingFinished && (key === "Enter" || key === " ")) {
      this.displayIndex = this.plainText.length;
      this.typingFinished = true;
      // Show options
      if (slide.type === "prompt" && slide.options) {
        this.optionsContainer.visible = true;
        this.updateOptionsDisplay();
      }
      this.renderContent();
      return;
    }

    if (slide.type === "prompt" && slide.options) {
      if (key === "ArrowLeft" || key === "h") {
        this.selectedOptionIndex = Math.max(0, this.selectedOptionIndex - 1);
        this.updateOptionsDisplay();
      } else if (key === "ArrowRight" || key === "l") {
        this.selectedOptionIndex = Math.min(slide.options.length - 1, this.selectedOptionIndex + 1);
        this.updateOptionsDisplay();
      } else if (key === "Enter" || key === " ") {
        const option = slide.options[this.selectedOptionIndex];
        if (option) {
          this.goToSlide(option.targetSlide);
        }
      }
    } else if (slide.type === "info") {
      if (key === "Enter" || key === " ") {
        this.nextSlide();
      }
    }
  }

  public setDebugStats(_text: string) {
    // Debug stats display removed - kept for API compatibility
  }
}
