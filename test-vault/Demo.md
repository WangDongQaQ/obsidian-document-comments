# Document Comments — live demo

Select any text and run **Add comment on selection** (command palette) or right-click → **Add comment**. The comment shows as a card in the right margin, aligned to the highlighted line. Hover a card to light up its anchor; click a card to jump to it.

We should <!--c:k3f9-->ship on Friday<!--/c:k3f9--> regardless of the QA timeline, because the release window closes Monday and we don't get another one until the end of the quarter.
<!--co:k3f9 by:kyle at:2026-06-17T10:00:00.000Z status:open quote:"ship on Friday"
kyle: I thought we agreed Thursday?
sam: Thursday is better for QA — Friday leaves no buffer.
+👍 sam, mike
+🎉 kyle
-->

Here is a second paragraph with <!--c:a7b2-->another highlighted span<!--/c:a7b2--> placed close to the first, so you can see the margin cards stack instead of overlapping.
<!--co:a7b2 by:sam at:2026-06-17T10:05:00.000Z status:open quote:"another highlighted span"
sam: Two anchors near each other should never collide in the margin.
-->

And a third point that is already <!--c:zz1q-->resolved<!--/c:zz1q--> — toggle "Show resolved comments" in settings to hide it.
<!--co:zz1q by:kyle at:2026-06-17T09:00:00.000Z status:resolved quote:"resolved"
kyle: Handled — marking this resolved.
-->

---

Everything between the markers above is plain text in this `.md` file. Open it in any editor (or hand it to an agent) and the comments read in context — no plugin required.
