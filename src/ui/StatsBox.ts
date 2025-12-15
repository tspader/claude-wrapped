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
import { SLIDES } from "./slides";
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

  // Layout
  private boxWidth: number = 0;
  private useLogo: boolean = false;

  // State
  private statsData: any = {};
  private currentSlideIndex: number = 0;

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

  // Debug Stats
  private debugStats: string = "";

  constructor(renderer: any, width: number, height: number, left: number, top: number) {
    this.boxWidth = width;
    // Account for border (2) and padding (2) on each side
    const innerWidth = width - 4;
    const innerHeight = height - 4;
    this.useLogo = innerWidth >= LOGO_WIDTH;

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

    // logo
    this.logoContainer = new BoxRenderable(renderer, {
      id: "logo-container",
      width: innerWidth,
      height: innerHeight,
      justifyContent: "center",
      alignItems: "center",
      flexDirection: "column",
      visible: true,
    });

    this.logoContainer.add(new TextRenderable(renderer, {
      id: "logo-text",
      content: this.buildLogo(),
      fg: "#FFFFFF",
      marginBottom: 1
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

    // title
    this.titleContainer = new BoxRenderable(renderer, {
      id: "title-container",
      width: innerWidth,
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

    this.normalContent.add(this.titleContainer);
    this.normalContent.add(this.contentText);

    this.container.add(this.logoContainer);
    this.container.add(this.normalContent);

    this.startSlide(0);
  }

  private buildLogo(): StyledText {
    const claudeStyle = fg(CLAUDE_COLOR);
    const wrappedStyle = fg(WRAPPED_COLOR);

    if (this.useLogo) {
      const parts: TextChunk[] = [];

      for (let i = 0; i < CLAUDE_LOGO.length; i++) {
        const line = CLAUDE_LOGO[i]!;
        if (i > 0) parts.push(plainChunk("\n"));
        parts.push(claudeStyle(line));
      }

      parts.push(plainChunk("\n"));

      for (let i = 0; i < WRAPPED_LOGO.length; i++) {
        const line = WRAPPED_LOGO[i]!;
        if (i > 0) parts.push(plainChunk("\n"));
        parts.push(wrappedStyle(line));
      }

      return concatStyledText(...parts);
    } else {
      return t`${claudeStyle("CLAUDE")} ${wrappedStyle("WRAPPED")}`;
    }
  }

  private buildTitle(): StyledText {
    const claudeStyle = fg(CLAUDE_COLOR);
    // Bold text - CLAUDE orange, WRAPPED white (centered via flexbox)
    return t`${bold(claudeStyle("CLAUDE"))} ${bold("WRAPPED")}`;
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

  private startSlide(index: number) {
    if (index >= SLIDES.length) return;
    this.currentSlideIndex = index;
    const slide = SLIDES[index];
    if (!slide) return;

    // Switch between logo slide (centered) and normal slides via visibility
    if (slide.id === "logo") {
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
    this.renderContent();

    if (slide.type === "action" && slide.onEnter) {
      slide.onEnter(this);
    }
  }

  public nextSlide() {
    this.startSlide(this.currentSlideIndex + 1);
  }

  public update(deltaTime: number) {
    const slide = SLIDES[this.currentSlideIndex];
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
        }
        this.renderContent();
      }
    }
  }

  private renderContent() {
    const slide = SLIDES[this.currentSlideIndex];
    if (!slide) return;

    // Slice styled text to visible characters
    let content = sliceStyledText(this.fullStyled, this.displayIndex);

    // Add options if prompt and typing finished
    if (this.typingFinished && slide.type === "prompt" && slide.options) {
      const optionParts: (StyledText | TextChunk)[] = [content, plainChunk("\n\n")];

      slide.options.forEach((opt, i) => {
        const isSelected = i === this.selectedOptionIndex;
        const marker = isSelected ? "> " : "  ";
        if (isSelected) {
          optionParts.push(plainChunk(marker));
          optionParts.push(opt.style(`[ ${opt.label} ]`));
          optionParts.push(plainChunk("   "));
        } else {
          optionParts.push(plainChunk(marker));
          optionParts.push(dim(opt.label));
          optionParts.push(plainChunk("   "));
        }
      });

      content = concatStyledText(...optionParts);
    }

    // Add debug stats when on "done" slide
    if (slide.id === "done" && this.debugStats) {
      content = concatStyledText(content, plainChunk("\n" + this.debugStats));
    }

    // Blinking cursor (hide on prompt slides after typing finishes)
    const hidePromptCursor = slide.type === "prompt" && this.typingFinished;
    if (this.showCursor && !hidePromptCursor) {
      content = concatStyledText(content, cursorStyle("█"));
    }

    this.contentText.content = content;
  }

  public async handleInput(key: string): Promise<void> {
    const slide = SLIDES[this.currentSlideIndex];
    if (!slide) return;

    // Fast forward typing
    if (!this.typingFinished && (key === "Enter" || key === " ")) {
      this.displayIndex = this.plainText.length;
      this.typingFinished = true;
      this.renderContent();
      return;
    }

    if (slide.type === "prompt" && slide.options) {
      if (key === "ArrowLeft" || key === "h") {
        this.selectedOptionIndex = Math.max(0, this.selectedOptionIndex - 1);
        this.renderContent();
      } else if (key === "ArrowRight" || key === "l") {
        this.selectedOptionIndex = Math.min(slide.options.length - 1, this.selectedOptionIndex + 1);
        this.renderContent();
      } else if (key === "Enter" || key === " ") {
        const option = slide.options[this.selectedOptionIndex];
        if (!option) return;
        const val = option.value;
        if (val === "yes") {
          this.nextSlide();
        } else {
          if (slide.id === "intro") {
            this.statsData = {};
            const doneIdx = SLIDES.findIndex(s => s.id === "done");
            this.startSlide(doneIdx);
            this.fullStyled = t`Visualization only mode.`;
            this.plainText = "Visualization only mode.";
            this.displayIndex = this.plainText.length;
            this.typingFinished = true;
            this.renderContent();
          } else {
            this.nextSlide();
          }
        }
      }
    } else if (slide.type === "info") {
      if (key === "Enter" || key === " ") {
        this.nextSlide();
      }
    }
  }

  public setDebugStats(text: string) {
    this.debugStats = text;
    // Only display debug stats when on the "done" slide (visualization mode)
    const slide = SLIDES[this.currentSlideIndex];
    if (slide && slide.id === "done") {
      this.renderContent();
    }
  }
}
