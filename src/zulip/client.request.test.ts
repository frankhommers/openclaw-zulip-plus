import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createZulipCustomProfileField,
  createZulipUser,
  addZulipCodePlayground,
  addZulipDefaultStream,
  createZulipInviteLink,
  createZulipSavedSnippet,
  createZulipClient,
  createZulipReminder,
  deleteZulipAttachment,
  deleteZulipSavedSnippet,
  deleteZulipReminder,
  fetchZulipMessageEditHistory,
  forwardZulipMessage,
  getZulipRealmPresence,
  listZulipCodePlaygrounds,
  listZulipDefaultStreams,
  listZulipAttachments,
  listZulipInvitations,
  listZulipSavedSnippets,
  listZulipReminders,
  removeZulipCodePlayground,
  removeZulipDefaultStream,
  reorderZulipCustomProfileFields,
  renderZulipMarkdownPreview,
  markAllZulipMessagesAsRead,
  searchZulipMessages,
  setZulipOwnPresence,
  resendZulipInvitation,
  revokeZulipInvitation,
  revokeZulipInviteLink,
  sendZulipInvitation,
  sendZulipTyping,
  updateZulipCustomProfileField,
  updateZulipUserProfileData,
  updateZulipUser,
  updateZulipSavedSnippet,
  deleteZulipCustomProfileField,
  zulipRequest,
} from "./client.js";

describe("zulipRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a Zulip User-Agent header on API requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await zulipRequest({
      auth: {
        baseUrl: "https://zulip.example.com",
        email: "bot@example.com",
        apiKey: "secret",
      },
      method: "GET",
      path: "/api/v1/server_settings",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringMatching(/openclaw/i),
        }),
      }),
    );
  });

  it("requests message edit history from /api/v1/messages/{id}/history", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: "success",
          message_history: [{
            prev_content: "Old content",
            content: "New content",
            timestamp: 1710000000,
          }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const history = await fetchZulipMessageEditHistory(client, "123");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/messages/123/history",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(history).toEqual([
      {
        prev_content: "Old content",
        content: "New content",
        timestamp: 1710000000,
      },
    ]);
  });

  it("supports message forward, markdown render, mark-all-read, and DM search narrow helpers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success", id: 222 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success", rendered: "<p>Hello</p>" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success", messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const forwarded = await forwardZulipMessage(client, {
      messageId: "123",
      to: "stream:ops",
      topic: "incident/123",
    });
    expect(forwarded).toEqual({ id: 222 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zulip.example.com/api/v1/messages/123/forward",
      expect.objectContaining({
        method: "POST",
        body: "to=stream%3Aops&topic=incident%2F123",
      }),
    );

    const render = await renderZulipMarkdownPreview(client, { content: "**Hello**" });
    expect(render).toEqual({ rendered: "<p>Hello</p>" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://zulip.example.com/api/v1/messages/render",
      expect.objectContaining({
        method: "POST",
        body: "content=**Hello**",
      }),
    );

    await markAllZulipMessagesAsRead(client);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://zulip.example.com/api/v1/mark_all_as_read",
      expect.objectContaining({ method: "POST" }),
    );

    await searchZulipMessages(client, {
      query: "deploy",
      dmWith: ["alice@example.com", "bob@example.com"],
      limit: 25,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("https://zulip.example.com/api/v1/messages?"),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const searchUrl = String((fetchMock.mock.calls[3] as [unknown])[0]);
    const parsed = new URL(searchUrl);
    const narrow = JSON.parse(parsed.searchParams.get("narrow") ?? "[]");
    expect(narrow).toEqual([
      { operator: "search", operand: "deploy" },
      { operator: "dm", operand: "alice@example.com,bob@example.com" },
    ]);
  });

  it("throws when Zulip typing endpoint returns an error payload", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "error", msg: "typing denied" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      sendZulipTyping(client, {
        op: "start",
        type: "stream",
        streamId: 42,
        topic: "deploy",
      }),
    ).rejects.toThrow("typing denied");
  });

  it("lists reminders from /api/v1/reminders", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: "success",
          reminders: [{ reminder_id: 1, scheduled_delivery_timestamp: 1710000000, content: "Follow up" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const reminders = await listZulipReminders(client);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/reminders",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(reminders).toEqual([{ reminder_id: 1, scheduled_delivery_timestamp: 1710000000, content: "Follow up" }]);
  });

  it("creates reminders via /api/v1/reminders", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success", reminder_id: 88 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const created = await createZulipReminder(client, {
      messageId: 99,
      scheduledDeliveryTimestamp: 1710000500,
      note: "Follow up",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/reminders",
      expect.objectContaining({
        method: "POST",
        body: "message_id=99&scheduled_delivery_timestamp=1710000500&note=Follow+up",
      }),
    );
    expect(created).toEqual({ reminder_id: 88 });
  });

  it("deletes reminders via /api/v1/reminders/{id}", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await deleteZulipReminder(client, 88);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/reminders/88",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("lists saved snippets from /api/v1/users/me/snippets", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: "success",
          snippets: [{ id: 11, title: "Deploy", content: "run tests", date_created: 1710000000 }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const snippets = await listZulipSavedSnippets(client);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/users/me/snippets",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(snippets).toEqual([
      { id: 11, title: "Deploy", content: "run tests", date_created: 1710000000 },
    ]);
  });

  it("creates a saved snippet via /api/v1/users/me/snippets", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success", id: 12 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const created = await createZulipSavedSnippet(client, {
      title: "Incident response",
      content: "1. page on-call",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/users/me/snippets",
      expect.objectContaining({
        method: "POST",
        body: "title=Incident+response&content=1.+page+on-call",
      }),
    );
    expect(created).toEqual({ id: 12 });
  });

  it("updates a saved snippet via /api/v1/users/me/snippets/{id}", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await updateZulipSavedSnippet(client, 12, {
      title: "Incident workflow",
      content: "1. acknowledge",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/users/me/snippets/12",
      expect.objectContaining({
        method: "PATCH",
        body: "title=Incident+workflow&content=1.+acknowledge",
      }),
    );
  });

  it("deletes a saved snippet via /api/v1/users/me/snippets/{id}", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ result: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await deleteZulipSavedSnippet(client, 12);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://zulip.example.com/api/v1/users/me/snippets/12",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("manages invitations endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: "success",
            invites: [{ id: 11, email: "new.user@example.com", invited: 1710000000 }],
            invite_links: [{ id: 21, link_url: "https://zulip.example.com/invite/abc" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: "success",
            invite_link_url: "https://zulip.example.com/invite/xyz",
            id: 99,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const listed = await listZulipInvitations(client);
    expect(listed.invites).toEqual([{ id: 11, email: "new.user@example.com", invited: 1710000000 }]);
    expect(listed.inviteLinks).toEqual([{ id: 21, linkUrl: "https://zulip.example.com/invite/abc" }]);

    await sendZulipInvitation(client, {
      emails: ["new.user@example.com"],
      streamIds: [3, 4],
      inviteAs: 400,
      includeRealmDefaultSubscriptions: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://zulip.example.com/api/v1/invites",
      expect.objectContaining({
        method: "POST",
        body: "invitee_emails=%5B%22new.user%40example.com%22%5D&stream_ids=%5B3%2C4%5D&invite_as=400&include_realm_default_subscriptions=false",
      }),
    );

    const createdLink = await createZulipInviteLink(client, {
      streamIds: [3],
      inviteAs: 600,
      inviteExpiresInMinutes: 1440,
    });
    expect(createdLink).toEqual({ invite_link_url: "https://zulip.example.com/invite/xyz", id: 99 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://zulip.example.com/api/v1/invites/multiuse",
      expect.objectContaining({
        method: "POST",
        body: "stream_ids=%5B3%5D&invite_as=600&invite_expires_in_minutes=1440",
      }),
    );

    await revokeZulipInviteLink(client, 99);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://zulip.example.com/api/v1/invites/multiuse/99/revoke",
      expect.objectContaining({ method: "POST" }),
    );

    await revokeZulipInvitation(client, 11);
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "https://zulip.example.com/api/v1/invites/11",
      expect.objectContaining({ method: "DELETE" }),
    );

    await resendZulipInvitation(client, 11);
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "https://zulip.example.com/api/v1/invites/11/resend",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("manages code playground and default stream endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: "success",
            playgrounds: [
              {
                id: 5,
                name: "GitHub",
                pygments_language: "python",
                url_prefix: "https://github.com/",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success", id: 9 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: "success",
            streams: [{ stream_id: 10, name: "ops", description: "Ops alerts" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const playgrounds = await listZulipCodePlaygrounds(client);
    expect(playgrounds).toEqual([
      {
        id: 5,
        name: "GitHub",
        pygments_language: "python",
        url_prefix: "https://github.com/",
      },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zulip.example.com/api/v1/realm/playgrounds",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );

    const created = await addZulipCodePlayground(client, {
      name: "Sourcegraph",
      pygmentsLanguage: "typescript",
      urlPrefix: "https://sourcegraph.example.com/",
    });
    expect(created).toEqual({ id: 9 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://zulip.example.com/api/v1/realm/playgrounds",
      expect.objectContaining({
        method: "POST",
        body: "name=Sourcegraph&pygments_language=typescript&url_prefix=https%3A%2F%2Fsourcegraph.example.com%2F",
      }),
    );

    await removeZulipCodePlayground(client, 9);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://zulip.example.com/api/v1/realm/playgrounds/9",
      expect.objectContaining({ method: "DELETE" }),
    );

    const defaultStreams = await listZulipDefaultStreams(client);
    expect(defaultStreams).toEqual([{ stream_id: 10, name: "ops", description: "Ops alerts" }]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://zulip.example.com/api/v1/default_streams",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );

    await addZulipDefaultStream(client, 10);
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "https://zulip.example.com/api/v1/default_streams",
      expect.objectContaining({ method: "POST", body: "stream_id=10" }),
    );

    await removeZulipDefaultStream(client, 10);
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "https://zulip.example.com/api/v1/default_streams/10",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("supports admin user and expanded presence endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: "success", presences: { "1": { website: { status: "active" } } } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await createZulipUser(client, {
      email: "new.user@example.com",
      fullName: "New User",
      password: "TempPass123!",
      role: 400,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zulip.example.com/api/v1/users",
      expect.objectContaining({
        method: "POST",
        body: "email=new.user%40example.com&full_name=New+User&password=TempPass123%21&role=400",
      }),
    );

    await updateZulipUser(client, 77, {
      fullName: "Updated User",
      role: 600,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://zulip.example.com/api/v1/users/77",
      expect.objectContaining({
        method: "PATCH",
        body: "full_name=Updated+User&role=600",
      }),
    );

    const presence = await getZulipRealmPresence(client);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://zulip.example.com/api/v1/realm/presence",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(presence).toEqual({ "1": { website: { status: "active" } } });

    await setZulipOwnPresence(client, { status: "active", pingOnly: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://zulip.example.com/api/v1/users/me/presence",
      expect.objectContaining({
        method: "POST",
        body: "status=active&ping_only=true",
      }),
    );
  });

  it("supports custom profile field writes and user profile data updates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success", id: 21 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const created = await createZulipCustomProfileField(client, {
      name: "Pager",
      fieldType: 1,
      hint: "Primary pager number",
      fieldData: '{"format":"phone"}',
      displayInProfileSummary: true,
    });
    expect(created).toEqual({ id: 21 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zulip.example.com/api/v1/realm/profile_fields",
      expect.objectContaining({
        method: "POST",
        body: "name=Pager&field_type=1&hint=Primary+pager+number&field_data=%7B%22format%22%3A%22phone%22%7D&display_in_profile_summary=true",
      }),
    );

    await updateZulipCustomProfileField(client, 21, {
      name: "Primary pager",
      hint: "Rotation phone number",
      displayInProfileSummary: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://zulip.example.com/api/v1/realm/profile_fields/21",
      expect.objectContaining({
        method: "PATCH",
        body: "name=Primary+pager&hint=Rotation+phone+number&display_in_profile_summary=false",
      }),
    );

    await deleteZulipCustomProfileField(client, 21);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://zulip.example.com/api/v1/realm/profile_fields/21",
      expect.objectContaining({ method: "DELETE" }),
    );

    await reorderZulipCustomProfileFields(client, [2, 1, 3]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://zulip.example.com/api/v1/realm/profile_fields",
      expect.objectContaining({
        method: "PATCH",
        body: "order=%5B2%2C1%2C3%5D",
      }),
    );

    await updateZulipUserProfileData(client, 77, [
      { id: 2, value: "On-call this week" },
      { id: 3, value: "UTC-5" },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "https://zulip.example.com/api/v1/users/77/profile_data",
      expect.objectContaining({
        method: "PATCH",
        body: "data=%5B%7B%22id%22%3A2%2C%22value%22%3A%22On-call+this+week%22%7D%2C%7B%22id%22%3A3%2C%22value%22%3A%22UTC-5%22%7D%5D",
      }),
    );
  });

  it("lists and deletes attachments endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: "success",
            attachments: [
              { id: 12, name: "incident.png", size: 2048, path_id: "abc", create_time: 1710000000, messages: [] },
            ],
            upload_space_used: 2048,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "success" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = createZulipClient({
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const listed = await listZulipAttachments(client);
    expect(listed.uploadSpaceUsed).toBe(2048);
    expect(listed.attachments).toHaveLength(1);

    await deleteZulipAttachment(client, 12);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://zulip.example.com/api/v1/attachments/12",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
