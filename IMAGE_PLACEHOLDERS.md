# Image Placeholders for README

This document lists all the image placeholders referenced in README.md that need screenshots.

## Existing Images (Already Present)
- ✅ `assets/images/get-clm-workbook-info.png` - Workbook tools demo
- ✅ `assets/images/get-wt-info.png` - Watchtower tools demo
- ✅ `assets/images/get-video-captions.png` - Video captions demo
- ✅ `assets/images/smithery-intall.png` - Smithery installation

## New Image Placeholders Needed

### Scripture Tools (NEW!)
1. **`assets/images/scripture-tools-demo.png`**
   - Location: Features section, after scripture tools description
   - Should show: Overview of all 3 scripture tools in action

2. **`assets/images/search-bible-books.png`**
   - Location: Examples section
   - Should show: search_bible_books tool being called and results
   - Example query: "matthew" or "gen"

3. **`assets/images/get-bible-verse.png`**
   - Location: Examples section
   - Should show: get_bible_verse tool returning John 3:16 or Matthew 24:14
   - Shows plain verse text output

4. **`assets/images/get-verse-with-study.png`**
   - Location: Examples section
   - Should show: get_verse_with_study tool with full study content
   - Include study notes, articles, cross-references

### RTF Parsing Examples (NEW!)
5. **`assets/images/workbook-parsed-content.png`**
   - Location: Examples section, after workbook content example
   - Should show: Parsed CLM workbook content (clean text, not RTF)
   - Highlight: parsedText field with readable content

6. **`assets/images/watchtower-parsed-content.png`**
   - Location: Examples section, after watchtower content example
   - Should show: Parsed Watchtower article (clean text, not RTF)
   - Highlight: parsedText field with "STUDY ARTICLE" and formatted text
   - Show size reduction (originalSize vs parsedSize)

## Screenshot Guidelines

### For Scripture Tools:
- Show Claude Code interface with tool calls
- Include both the tool invocation and the response
- Make sure book numbers and references are visible
- For study content, show at least one study note or article

### For RTF Parsing:
- Show the JSON output with both originalSize and parsedSize
- Display a portion of the parsedText to show it's readable
- Highlight the ~70% size reduction
- Use a real Watchtower or Workbook file for authenticity

## Image Dimensions
- Recommended width: 800-1200px
- Format: PNG with transparency where applicable
- Compress for web to keep repository size reasonable
