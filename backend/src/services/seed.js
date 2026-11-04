import { Template } from "../models/Template.js";

// Starter templates every new account gets (the same ones the app shipped with).
export function seedTemplatesFor(user) {
  const first = user.name.split(" ")[0];
  return Template.insertMany([
    {
      userId: user._id,
      name: "Hiring Outreach",
      category: "Hiring",
      subject: "Application regarding opportunities at {{company}}",
      body: `Hi {{name|there}},\n\nI hope you are doing well. I came across {{company}} and wanted to connect with you as {{title}} regarding opportunities.\n\nRegards,\n${first}`,
      isFavorite: true,
    },
    {
      userId: user._id,
      name: "Client Intro",
      category: "Client",
      subject: "Partnering with {{company}}",
      body: `Hi {{name|there}},\n\nI'd love to explore how we can help {{company}} grow.\n\nBest,\n${first}`,
    },
    {
      userId: user._id,
      name: "Follow-up",
      category: "Follow-up",
      subject: "Following up — {{company}}",
      body: `Hi {{name|there}},\n\nJust following up on my previous email. Would love your thoughts.\n\nThanks,\n${first}`,
    },
  ]);
}
