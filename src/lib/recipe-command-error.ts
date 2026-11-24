export function recipeCommandError(error: { code?: string | null; message: string }): Error {
  if (
    error.code === "PGRST202" ||
    /could not find.*neo_recipe_(sheet_save|activate).*schema cache/i.test(error.message)
  ) {
    return new Error(
      "Recipe saving/approval is not installed or refreshed on this database yet. Manual entry and spreadsheet import need the same atomic recipe update. Your form has not been saved; keep it open while the database update is applied.",
    );
  }
  return new Error(error.message);
}
