// Bad fixture for R05 (Next.js Server Action — inline `'use server'`).
// The action is declared inside a Server Component and reads FormData
// directly. Same bypass shape as the file-level form, different surface.

export default function Page() {
  async function deletePost(formData: FormData) {
    "use server";
    const id = formData.get("id");
    // pretend `prisma.post.delete({ where: { id: id as string } })` is here
    return { deleted: id };
  }

  return (
    <form action={deletePost}>
      <input name="id" />
      <button type="submit">Delete</button>
    </form>
  );
}
