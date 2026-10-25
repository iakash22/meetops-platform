# Self-hosted fonts

Both fonts are licensed under the SIL Open Font License 1.1 (see `OFL-*.txt`). Neither licence
declares a Reserved Font Name, so the subset files below are permitted Modified Versions.

| File                        | Source (official)                                                                                            | Version | Axes         | Bytes  | sha256 (first 12) |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------- | ------------ | ------ | ----------------- |
| `InterVariable-latin.woff2` | https://rsms.me/inter/font-files/InterVariable.woff2 (rsms/inter)                                            | 4.1     | wght 100–900 | 58,128 | `9e6ac6f346c5`    |
| `JetBrainsMono-latin.woff2` | `fonts/variable/JetBrainsMono[wght].ttf` from https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304 | 2.304   | wght 100–800 | 40,372 | `1b8f5583a428`    |

## How they were produced (fontTools 4.x, on a dev box — not a repo dependency)

```sh
U="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
# Inter: pin optical size to "text" (opsz=14) to drop the opsz axis (-33 KB), then subset to Latin.
fonttools varLib.instancer InterVariable.woff2 opsz=14 -o inter-text.woff2
pyftsubset inter-text.woff2 --unicodes="$U" --flavor=woff2 \
  --layout-features='kern,calt,ccmp,locl,mark,mkmk,case,tnum,pnum,zero,frac,numr,dnom,sups,cv11,ss01,ss03' \
  --output-file=InterVariable-latin.woff2
pyftsubset 'JetBrainsMono[wght].ttf' --unicodes="$U" --flavor=woff2 \
  --layout-features='calt,ccmp,locl,mark,mkmk,zero,frac,numr,dnom,sups,case' \
  --output-file=JetBrainsMono-latin.woff2
```

The unicode range is the Google Fonts "latin" subset and must match `unicode-range` in
`src/index.css`. Characters outside it fall back to the system stack. Add a `latin-ext` file the
same way if needed.
