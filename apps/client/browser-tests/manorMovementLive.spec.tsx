import { expect, test } from "@playwright/experimental-ct-react";

import { ManorMovementLiveStory } from "./ManorMovementLiveStory.js";

test("two browser floor clicks emit one Manor command and converge to changed authority", async ({
  mount,
  page
}) => {
  await mount(<ManorMovementLiveStory />);
  await expect(page.getByTestId("manor-ready")).toHaveText("ready");
  const floor = page.locator(".manor-floor");
  await expect(floor).toBeVisible();
  const before = JSON.parse(await page.getByTestId("authority-position").textContent() ?? "null");
  const box = await floor.boundingBox();
  if (!box) throw new Error("Manor floor did not have a browser layout box");
  await page.mouse.click(box.x + box.width * .22, box.y + box.height * .25);
  await page.mouse.click(box.x + box.width * .225, box.y + box.height * .255);
  await expect(page.getByTestId("movement-count")).toHaveText("1");
  await expect(page.getByTestId("active-session-id")).toHaveText("browser-manor-session");
  await expect(page.getByTestId("movement-sequence")).toHaveText("1");
  const after = JSON.parse(await page.getByTestId("authority-position").textContent() ?? "null");
  expect(after).not.toEqual(before);
  await expect(page.getByTestId("last-request-id")).not.toHaveText("none");
});

test("native double-click dedupes against the same command path and UI self tap suppresses movement", async ({
  mount,
  page
}) => {
  await mount(<ManorMovementLiveStory />);
  await expect(page.getByTestId("manor-ready")).toHaveText("ready");
  const floor = page.locator(".manor-floor");
  const box = await floor.boundingBox();
  if (!box) throw new Error("Manor floor did not have a browser layout box");

  await floor.dblclick({ position: { x: box.width * .28, y: box.height * .3 } });
  await expect(page.getByTestId("movement-count")).toHaveText("1");
  await page.getByRole("button", { name: "Your character" }).click();
  await expect(page.getByRole("complementary", { name: "Your Manor actions" })).toBeVisible();
  await expect(page.getByTestId("movement-count")).toHaveText("1");
});

test("a correlated server movement rejection is surfaced to the player", async ({ mount, page }) => {
  await mount(<ManorMovementLiveStory />);
  await expect(page.getByTestId("manor-ready")).toHaveText("ready");
  await page.getByRole("button", { name: "Send rejected target" }).click();
  await expect(page.getByTestId("movement-count")).toHaveText("1");
  await expect(page.getByTestId("last-request-id")).not.toHaveText("none");
  await expect(page.getByTestId("action-error")).toHaveText(
    "That target is blocked by a manor fixture."
  );
});

test.describe("touch input", () => {
  test.use({ hasTouch: true, isMobile: true });

  async function dispatchTouchContact(
    client: { send(command: string, params?: object): Promise<unknown> },
    start: { x: number; y: number },
    end: { x: number; y: number },
    id: number
  ): Promise<void> {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id, x: start.x, y: start.y, radiusX: 1, radiusY: 1 }]
    });
    if (start.x !== end.x || start.y !== end.y) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ id, x: end.x, y: end.y, radiusX: 1, radiusY: 1 }]
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: []
    });
  }

  test("browser touch taps dedupe through the real Manor command port", async ({ mount, page }) => {
    await mount(<ManorMovementLiveStory />);
    await expect(page.getByTestId("manor-ready")).toHaveText("ready");
    const floor = page.locator(".manor-floor");
    const box = await floor.boundingBox();
    if (!box) throw new Error("Manor floor did not have a browser layout box");

    await page.touchscreen.tap(box.x + box.width * .35, box.y + box.height * .35);
    await page.touchscreen.tap(box.x + box.width * .355, box.y + box.height * .355);
    await expect(page.getByTestId("movement-count")).toHaveText("1");
    await expect(page.getByTestId("movement-sequence")).toHaveText("1");
  });

  test("explicit touch contact motion stays within the shared 14px threshold", async ({
    mount,
    page
  }) => {
    await mount(<ManorMovementLiveStory />);
    await expect(page.getByTestId("manor-ready")).toHaveText("ready");
    const floor = page.locator(".manor-floor");
    const box = await floor.boundingBox();
    if (!box) throw new Error("Manor floor did not have a browser layout box");
    const cdp = await page.context().newCDPSession(page);
    const firstStart = { x: box.x + box.width * .42, y: box.y + box.height * .56 };
    const firstEnd = { x: firstStart.x + 10, y: firstStart.y + 5 };
    const secondEnd = { x: firstEnd.x + 8, y: firstEnd.y + 6 };

    await dispatchTouchContact(cdp, firstStart, firstEnd, 101);
    await page.waitForTimeout(40);
    await dispatchTouchContact(cdp, firstEnd, secondEnd, 102);
    await expect(page.getByTestId("movement-count")).toHaveText("1");
    await expect(page.getByTestId("movement-sequence")).toHaveText("1");
  });

  test("touch drift beyond 14px cancels movement and an unrecognized touch can use native fallback", async ({
    mount,
    page
  }) => {
    await mount(<ManorMovementLiveStory />);
    await expect(page.getByTestId("manor-ready")).toHaveText("ready");
    const floor = page.locator(".manor-floor");
    const box = await floor.boundingBox();
    if (!box) throw new Error("Manor floor did not have a browser layout box");
    const cdp = await page.context().newCDPSession(page);
    const cancelledStart = { x: box.x + box.width * .52, y: box.y + box.height * .58 };
    await dispatchTouchContact(cdp, cancelledStart, { x: cancelledStart.x + 15, y: cancelledStart.y }, 201);
    await page.waitForTimeout(180);
    await expect(page.getByTestId("movement-count")).toHaveText("0");

    const fallback = { x: box.x + box.width * .62, y: box.y + box.height * .44 };
    await dispatchTouchContact(cdp, fallback, fallback, 202);
    await floor.dispatchEvent("dblclick", {
      button: 0,
      clientX: fallback.x,
      clientY: fallback.y
    });
    await expect(page.getByTestId("movement-count")).toHaveText("1");
  });
});
