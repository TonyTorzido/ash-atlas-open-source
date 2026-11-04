import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";

import { ChatProtectionStory } from "./ChatProtectionStory.js";

test("Messages envelope stays flush through hover, focus, active, unread, and attention states", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const component = await mount(
    <ChatProtectionStory uiProfile="phone" unreadMessageCount={0} />
  );
  const bar = page.getByRole("region", { name: "Chat" });
  const online = bar.locator(".chat-top-bar-online");
  const picker = bar.locator(".chat-channel-picker");
  const room = page.getByRole("button", { name: "Select chat room" });
  const messages = page.getByRole("button", { name: "Open Messages" });
  const normal = await chatGeometry(bar, online, messages);
  expectFlushChatGeometry(normal);
  await expect(bar).toHaveCSS("border-radius", "8px");
  await expect(picker).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(picker).toHaveCSS("border-top-width", "0px");
  await expect(picker).toHaveCSS("box-shadow", "none");
  await expect(room).toHaveCSS("border-radius", "8px 0px 0px 8px");
  await expect(room).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(room).toHaveCSS("background-image", "none");
  await expect(room).toHaveCSS("border-top-width", "0px");
  await expect(room).toHaveCSS("box-shadow", "none");
  await expect(messages).toHaveCSS("width", "44px");
  await expect(messages).toHaveCSS("border-radius", "0px 8px 8px 0px");
  await expect(messages).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(messages).toHaveCSS("background-image", "none");
  await expect(messages).toHaveCSS("box-shadow", "none");
  await expect(messages).toHaveCSS("transform", "none");
  await expect(messages.locator("svg")).toHaveCSS("display", "block");

  await messages.hover();
  expect(await chatGeometry(bar, online, messages)).toEqual(normal);
  await messages.focus();
  expect(await chatGeometry(bar, online, messages)).toEqual(normal);
  const messageBox = await messages.boundingBox();
  expect(messageBox).not.toBeNull();
  await page.mouse.move(
    messageBox!.x + messageBox!.width / 2,
    messageBox!.y + messageBox!.height / 2
  );
  await page.mouse.down();
  expect(await chatGeometry(bar, online, messages)).toEqual(normal);
  await page.mouse.up();

  await component.update(
    <ChatProtectionStory
      uiProfile="phone"
      unreadMessageCount={14}
      messageAttentionRevision={0}
    />
  );
  const unreadMessages = page.getByRole("button", { name: "Open Messages, 14 unread" });
  expect(await chatGeometry(bar, online, unreadMessages)).toEqual(normal);
  await expect(unreadMessages).toHaveText("\u2022");

  await component.update(
    <ChatProtectionStory
      uiProfile="phone"
      unreadMessageCount={14}
      messageAttentionRevision={1}
    />
  );
  const attentionMessages = page.getByRole("button", { name: "Open Messages, 14 unread" });
  await expect(attentionMessages).toHaveClass(/message-attention/);
  expect(await chatGeometry(bar, online, attentionMessages)).toEqual(normal);
  await expect(attentionMessages).toHaveText("\u2022");
  await expect(attentionMessages).toHaveCSS("transform", "none");

  await room.click();
  const listbox = page.getByRole("listbox", { name: "Chat rooms" });
  await expect(listbox).toBeVisible();
  const [barBox, listboxBox] = await Promise.all([bar.boundingBox(), listbox.boundingBox()]);
  expect(barBox).not.toBeNull();
  expect(listboxBox).not.toBeNull();
  expect(listboxBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Open Local chat" })).toBeVisible();
});

for (const scenario of [
  { profile: "phone" as const, width: 390, height: 844 },
  { profile: "tablet" as const, width: 1024, height: 768 },
  { profile: "desktop" as const, width: 1280, height: 900 }
]) {
  test(`${scenario.profile} chat uses four compact themed cells and a 10+ unread dot`, async ({
    page,
    mount
  }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await mount(
      <ChatProtectionStory
        uiProfile={scenario.profile}
        unreadMessageCount={14}
      />
    );

    const bar = page.getByRole("region", { name: "Chat" });
    const room = page.getByRole("button", { name: "Select chat room" });
    const preview = page.getByRole("button", { name: "Open General chat" });
    const online = bar.locator(".chat-top-bar-online");
    const messages = page.getByRole("button", { name: "Open Messages, 14 unread" });
    await expect(messages).toHaveText("•");
    await expect(bar.locator(".chat-top-bar-room-name")).toBeHidden();
    await expect(messages).toHaveCSS("width", "44px");
    await expect(bar).toHaveCSS("border-top-color", "rgb(151, 112, 61)");
    const boxes = await Promise.all([
      room.boundingBox(),
      preview.boundingBox(),
      online.boundingBox(),
      messages.boundingBox()
    ]);
    for (const box of boxes) expect(box).not.toBeNull();
    for (let index = 1; index < boxes.length; index += 1) {
      expect(Math.abs(
        boxes[index]!.x - (boxes[index - 1]!.x + boxes[index - 1]!.width)
      )).toBeLessThanOrEqual(1);
    }
  });
}

async function chatGeometry(
  bar: Locator,
  online: Locator,
  messages: Locator
): Promise<{
  bar: { top: number; bottom: number };
  online: { top: number; bottom: number; center: number };
  messages: { top: number; bottom: number; center: number; width: number; height: number };
}> {
  return pageGeometry(bar, online, messages);
}

async function pageGeometry(
  bar: Locator,
  online: Locator,
  messages: Locator
) {
  const [barBox, onlineBox, messagesBox] = await Promise.all([
    bar.boundingBox(),
    online.boundingBox(),
    messages.boundingBox()
  ]);
  expect(barBox).not.toBeNull();
  expect(onlineBox).not.toBeNull();
  expect(messagesBox).not.toBeNull();
  return {
    bar: { top: barBox!.y, bottom: barBox!.y + barBox!.height },
    online: {
      top: onlineBox!.y,
      bottom: onlineBox!.y + onlineBox!.height,
      center: onlineBox!.y + onlineBox!.height / 2
    },
    messages: {
      top: messagesBox!.y,
      bottom: messagesBox!.y + messagesBox!.height,
      center: messagesBox!.y + messagesBox!.height / 2,
      width: messagesBox!.width,
      height: messagesBox!.height
    }
  };
}

function expectFlushChatGeometry(geometry: Awaited<ReturnType<typeof chatGeometry>>): void {
  expect(Math.abs(geometry.messages.top - geometry.online.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.messages.bottom - geometry.online.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.messages.center - geometry.online.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.messages.top - geometry.bar.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.messages.bottom - geometry.bar.bottom)).toBeLessThanOrEqual(1);
}

test("desktop Chromium exposes a visible, closable General overlay above protection", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(<ChatProtectionStory />);
  await page.getByRole("button", { name: "Select chat room" }).click();
  await page.getByRole("option", { name: "Local" }).click();
  await page.getByRole("button", { name: "Select chat room" }).click();
  await page.getByRole("option", { name: "General" }).click();
  await page.getByRole("button", { name: "Open General chat" }).click();

  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const overlay = document.querySelector<HTMLElement>(".mobile-chat-overlay")!;
    const protection = document.querySelector<HTMLElement>(
      '[data-mobile-chat-protection-owner="true"]'
    )!;
    const close = overlay.querySelector<HTMLElement>('[data-mobile-chat-close="true"]')!;
    const hud = document.querySelector<HTMLElement>(".phone-hud")!;
    const layer = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        height: rect.height,
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        pointerEvents: style.pointerEvents,
        zIndex: Number(style.zIndex)
      };
    };
    return {
      protected: root.dataset.mobileChatProtected,
      overlay: layer(overlay),
      protection: layer(protection),
      close: layer(close),
      hud: layer(hud)
    };
  });

  expect(metrics.protected).toBe("true");
  expect(metrics.overlay.width).toBeGreaterThan(0);
  expect(metrics.overlay.height).toBeGreaterThan(0);
  expect(metrics.overlay.visibility).toBe("visible");
  expect(metrics.overlay.opacity).toBeGreaterThan(0);
  expect(metrics.overlay.pointerEvents).not.toBe("none");
  expect(metrics.overlay.zIndex).toBeGreaterThan(metrics.protection.zIndex);
  expect(metrics.close.width).toBeGreaterThan(0);
  expect(metrics.close.pointerEvents).not.toBe("none");
  expect(metrics.hud.visibility).toBe("hidden");
  expect(metrics.hud.pointerEvents).toBe("none");

  await page.keyboard.press("Escape");
  await expect(page.locator(".mobile-chat-overlay")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-chat-protected", "true");
});

test("invalid overlay geometry aborts without hiding gameplay and stale startup locks are sanitized", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.mobileChatProtected = "true";
    root.dataset.mobileKeyboardPhase = "opening";
    root.dataset.iosStandaloneChatLocked = "true";
  });
  await mount(<ChatProtectionStory zeroSized />);
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-chat-protected", "true");
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-keyboard-phase", "opening");
  await expect(page.locator("html")).not.toHaveAttribute("data-ios-standalone-chat-locked", "true");

  await page.getByRole("button", { name: "Open General chat" }).click();
  await expect(page.getByRole("alert")).toContainText("Gameplay has been restored");
  await expect(page.locator(".mobile-chat-overlay")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-chat-protected", "true");
  await expect(page.getByTestId("phone-hud")).toBeVisible();
});

test("rapid open-close-open and layout changes retain one protection owner", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(<ChatProtectionStory />);
  const open = page.getByRole("button", { name: "Open General chat" });
  await open.click();
  await page.getByRole("button", { name: "Close chat panel" }).click();
  await open.click();
  await page.evaluate(() => {
    document.documentElement.dataset.layoutMode = "compact";
  });
  await expect(page.locator('[data-mobile-chat-protection-owner="true"]')).toHaveCount(1);
  await expect(page.locator(".mobile-chat-overlay")).toBeVisible();
  await page.getByRole("button", { name: "Close chat panel" }).click();
  await expect(page.locator('[data-mobile-chat-protection-owner="true"]')).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-chat-protected", "true");
});

test("the active invariant guard restores gameplay after the overlay collapses", async ({
  page,
  mount
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(<ChatProtectionStory />);
  await page.getByRole("button", { name: "Open General chat" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mobile-chat-protected", "true");
  await page.locator(".mobile-chat-overlay").evaluate((element) => {
    (element as HTMLElement).style.width = "0";
    (element as HTMLElement).style.height = "0";
  });
  await expect(page.getByRole("alert")).toContainText("Gameplay has been restored");
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-chat-protected", "true");
  await expect(page.getByTestId("phone-hud")).toBeVisible();
});

test("browser Back closes chat through the same clean state", async ({ page, mount }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(<ChatProtectionStory />);
  await page.getByRole("button", { name: "Open General chat" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mobile-chat-protected", "true");
  await page.goBack();
  await expect(page.locator(".mobile-chat-overlay")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-chat-protected", "true");
  await expect(page.getByTestId("phone-hud")).toBeVisible();
});

test.describe("Android keyboard docking geometry", () => {
  for (const model of ["visual-only", "layout-and-visual"] as const) {
    test(`${model} resize docks once in flow and closes without a final visualViewport event`, async ({
      page,
      mount
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mount(<ChatProtectionStory keyboardModel={model} />);
      await page.getByRole("button", { name: "Open General chat" }).click();
      const draft = page.getByPlaceholder("Message General");
      await draft.focus();
      await page.evaluate(() => {
        (
          window as Window & {
            __setChatKeyboardViewport?: (
              height: number,
              offsetTop?: number,
              notify?: boolean
            ) => void;
          }
        ).__setChatKeyboardViewport?.(500, 0, true);
      });
      await expect(page.locator("html")).toHaveAttribute("data-mobile-keyboard-phase", "open");

      const openGeometry = await page.evaluate(() => {
        const root = document.documentElement;
        const overlay = document.querySelector<HTMLElement>(".mobile-chat-overlay")!;
        const composer = document.querySelector<HTMLElement>("[data-mobile-chat-composer]")!;
        const messages = document.querySelector<HTMLElement>("[data-mobile-chat-message-region]")!;
        const overlayRect = overlay.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const messageRect = messages.getBoundingClientRect();
        return {
          applied: Number.parseFloat(
            root.style.getPropertyValue("--mobile-chat-applied-keyboard-inset")
          ),
          overlayBottom: overlayRect.bottom,
          composerTop: composerRect.top,
          composerBottom: composerRect.bottom,
          messagesBottom: messageRect.bottom
        };
      });
      expect(Math.abs(openGeometry.composerBottom - 500)).toBeLessThanOrEqual(8);
      expect(openGeometry.messagesBottom).toBeLessThanOrEqual(openGeometry.composerTop + 1);
      if (model === "visual-only") {
        expect(openGeometry.applied).toBeGreaterThan(300);
        expect(openGeometry.overlayBottom).toBeGreaterThan(800);
      } else {
        expect(openGeometry.applied).toBe(0);
        expect(Math.abs(openGeometry.overlayBottom - 500)).toBeLessThanOrEqual(1);
      }

      await page.evaluate(() => {
        (
          window as Window & {
            __setChatKeyboardViewport?: (
              height: number,
              offsetTop?: number,
              notify?: boolean
            ) => void;
          }
        ).__setChatKeyboardViewport?.(844, 0, false);
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await expect(page.locator("html")).toHaveAttribute(
        "data-mobile-keyboard-phase",
        "closed",
        { timeout: 750 }
      );

      const closedGeometry = await page.evaluate(() => {
        const root = document.documentElement;
        const overlay = document.querySelector<HTMLElement>(".mobile-chat-overlay")!;
        const composer = document.querySelector<HTMLElement>("[data-mobile-chat-composer]")!;
        const messages = document.querySelector<HTMLElement>("[data-mobile-chat-message-region]")!;
        return {
          applied: root.style.getPropertyValue("--mobile-chat-applied-keyboard-inset"),
          committed: root.dataset.mobileKeyboardCommitted,
          overlayBottom: overlay.getBoundingClientRect().bottom,
          composerBottom: composer.getBoundingClientRect().bottom,
          composerTop: composer.getBoundingClientRect().top,
          messagesBottom: messages.getBoundingClientRect().bottom
        };
      });
      expect(closedGeometry.applied).toBe("0px");
      expect(closedGeometry.committed).toBe("false");
      expect(Math.abs(closedGeometry.composerBottom - closedGeometry.overlayBottom))
        .toBeLessThanOrEqual(8);
      expect(closedGeometry.messagesBottom).toBeLessThanOrEqual(closedGeometry.composerTop + 1);
      await expect(draft).toHaveValue("");
      await expect(page.locator('[data-mobile-chat-protection-owner="true"]')).toHaveCount(1);
    });
  }
});
